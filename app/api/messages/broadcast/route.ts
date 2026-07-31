/**
 * POST /api/messages/broadcast
 *
 * Mass guest messaging — fan out ONE English message to a segment of current or
 * upcoming guests. OTA guests (Booking.com / Airbnb) get a Beds24 chat message;
 * direct-booking guests get an email (when `emailDirect` and an address exist).
 * One-way only — guest replies land in their existing individual chat thread.
 *
 * Body: {
 *   segment: 'staying' | 'arriving' | 'leaving',
 *   days?: number,           // arriving/leaving only, 0..60
 *   message: string,         // required unless dryRun
 *   subject?: string,        // email subject; defaults to "Baker House Apartments"
 *   emailDirect?: boolean,   // default true
 *   dryRun?: boolean,        // classify recipients WITHOUT sending
 * }
 *
 * Recipients are re-resolved SERVER-SIDE from buildReservationSet — the client's
 * segment descriptor is trusted, its recipient list is not. Auth: admin / super.
 */
import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { requireRole } from '@/utils/authGuard';
import { getAccessToken } from '@/utils/beds24Auth';
import { sendBeds24Message } from '@/utils/beds24Messages';
import { buildReservationSet } from '@/utils/beds24Reservations';
import { sendGuestEmail } from '@/utils/guestEmail';
import {
  resolveRecipients,
  tallyRecipients,
  pragueToday,
  type Segment,
} from '@/utils/massMessageRecipients';

// Sequential sends can run long on a large segment; allow headroom (Vercel Pro).
export const maxDuration = 300;

const MAX_RECIPIENTS = 150;
const SEND_DELAY_MS = 350; // pace Beds24 chat sends against the credit bucket
const LOG_KEY = 'baker:mass-message-log';
const DEFAULT_SUBJECT = 'Baker House Apartments';
const VALID_SEGMENTS: Segment[] = ['staying', 'arriving', 'leaving'];

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Wrap the operator's plain-text message as minimal, safe HTML. */
function renderHtml(text: string): string {
  const body = escapeHtml(text).replace(/\r\n/g, '\n').replace(/\n/g, '<br/>');
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#111">${body}</div>`;
}

/** Retry once (after 1s) on a Beds24 rate-limit / 5xx / timeout, then give up. */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/(?:^|[^\d])(?:429|5\d\d)(?:[^\d]|$)/.test(msg) || /timeout/i.test(msg)) {
      await sleep(1000);
      return await fn();
    }
    throw err;
  }
}

interface SendResult {
  reservationNumber: string;
  name: string;
  room: string;
  channel: string;
  method: 'chat' | 'email' | 'skipped';
  status: 'sent' | 'failed' | 'skipped';
  error?: string;
  reason?: string;
}

export async function POST(req: NextRequest) {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  let body: {
    segment?: string;
    days?: number;
    message?: string;
    subject?: string;
    emailDirect?: boolean;
    dryRun?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const segment = body.segment as Segment;
  if (!VALID_SEGMENTS.includes(segment)) {
    return NextResponse.json({ error: 'Invalid `segment`' }, { status: 400 });
  }

  const dryRun = body.dryRun === true;
  const emailDirect = body.emailDirect !== false; // default true
  const message = (body.message ?? '').trim();
  const subject = (body.subject ?? '').trim() || DEFAULT_SUBJECT;

  let days = 0;
  if (segment === 'arriving' || segment === 'leaving') {
    days = Number(body.days);
    if (!Number.isInteger(days) || days < 0 || days > 60) {
      return NextResponse.json(
        { error: '`days` must be an integer between 0 and 60' },
        { status: 400 },
      );
    }
  }

  // A real send needs a message; dryRun is preview-only so empty is allowed.
  if (!dryRun && !message) {
    return NextResponse.json({ error: '`message` is required' }, { status: 400 });
  }

  let reservations;
  try {
    reservations = await buildReservationSet({ fullSync: false });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to load reservations';
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  const recipients = resolveRecipients(reservations, {
    segment,
    days,
    emailDirect,
    today: pragueToday(),
  });
  const counts = tallyRecipients(recipients);

  if (recipients.length > MAX_RECIPIENTS) {
    return NextResponse.json(
      {
        error: `Too many recipients (${recipients.length}). Narrow the range — the cap is ${MAX_RECIPIENTS}.`,
        counts,
      },
      { status: 413 },
    );
  }

  if (dryRun) {
    return NextResponse.json({ ok: true, dryRun: true, counts, recipients });
  }

  // ── Real send ──────────────────────────────────────────────────────────
  const results: SendResult[] = [];

  // Acquire one shared Beds24 token for the whole batch (skip if no chat sends).
  let token: string | undefined;
  if (recipients.some((r) => r.delivery === 'chat')) {
    try {
      token = await getAccessToken();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Beds24 authentication failed';
      return NextResponse.json({ error: `Beds24 authentication failed: ${msg}` }, { status: 502 });
    }
  }

  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    const base = {
      reservationNumber: r.reservationNumber,
      name: r.name,
      room: r.room,
      channel: r.channel,
    };

    if (r.delivery === 'unreachable') {
      results.push({ ...base, method: 'skipped', status: 'skipped', reason: r.reason });
      continue;
    }

    try {
      if (r.delivery === 'chat' && r.bookingId != null) {
        await withRetry(() => sendBeds24Message(r.bookingId as number, message, token));
        results.push({ ...base, method: 'chat', status: 'sent' });
      } else if (r.delivery === 'email' && r.email) {
        await withRetry(() =>
          sendGuestEmail({ to: r.email as string, subject, html: renderHtml(message) }),
        );
        results.push({ ...base, method: 'email', status: 'sent' });
      } else {
        results.push({ ...base, method: 'skipped', status: 'skipped', reason: 'bad-booking-id' });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Send failed';
      results.push({
        ...base,
        method: r.delivery === 'chat' ? 'chat' : 'email',
        status: 'failed',
        error: msg,
      });
    }

    // Pace out real sends (no trailing delay, and none after skips).
    if (i < recipients.length - 1) {
      await sleep(SEND_DELAY_MS);
    }
  }

  const resultCounts = {
    sent: results.filter((r) => r.status === 'sent').length,
    failed: results.filter((r) => r.status === 'failed').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
  };

  // Best-effort audit log — a failed Redis write never rolls back sends.
  const redis = getRedis();
  if (redis) {
    try {
      const entry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        sentAt: new Date().toISOString(),
        sentBy: guard.email,
        segment,
        days,
        emailDirect,
        subject,
        message,
        counts: resultCounts,
        results,
      };
      const existing = (await redis.get<unknown[]>(LOG_KEY)) ?? [];
      await redis.set(LOG_KEY, [...existing, entry].slice(-200));
    } catch (logErr) {
      console.error('[messages/broadcast] Failed to append send log:', logErr);
    }
  }

  return NextResponse.json({ ok: true, counts: resultCounts, results });
}
