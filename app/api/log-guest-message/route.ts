/**
 * POST /api/log-guest-message
 *
 * Appends an entry to the guest-message audit log when the operator dispatches
 * a non-email message that this server didn't actually send — currently the
 * WhatsApp "Open in WhatsApp" flow, where the actual delivery is the user
 * tapping Send inside WhatsApp.
 *
 * Why a separate route: send-guest-email both SENDS and LOGS. WhatsApp opens
 * a wa.me deeplink on the client, so the server's only job here is the log
 * entry. Splitting routes keeps each endpoint's contract straightforward
 * (and means a future "abort the wa.me open" doesn't risk a phantom log entry
 * for an email that didn't go out).
 *
 * Body:
 *   {
 *     channel: 'whatsapp',
 *     to: '+420...',            // recipient identifier (phone digits)
 *     templateId: 'thank-you',
 *     templateLabel: 'Thank You',
 *     reservationNumber: 'BH-...',
 *   }
 *
 * Returns { ok: true } on success. Best-effort — Redis outage doesn't fail
 * the response (the message has already been opened in WhatsApp client-side;
 * we don't want the UI flagging "send failed" when the only thing that
 * failed is the audit trail).
 *
 * Auth: admin / super.
 */

import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { requireRole } from '@/utils/authGuard';
import type { EmailSendLogEntry } from '@/types/emailSendLog';

const LOG_KEY = 'baker:email-send-log';

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export async function POST(req: NextRequest) {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  let body: {
    channel?: string;
    to?: string;
    templateId?: string;
    templateLabel?: string;
    reservationNumber?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const channel = body.channel?.trim();
  const to = body.to?.trim();
  const templateId = body.templateId?.trim();
  const templateLabel = body.templateLabel?.trim();
  const reservationNumber = body.reservationNumber?.trim();

  if (channel !== 'whatsapp') {
    return NextResponse.json(
      { error: 'Only channel="whatsapp" is supported by this route' },
      { status: 400 },
    );
  }
  if (!to) return NextResponse.json({ error: '`to` is required' }, { status: 400 });
  if (!templateId)
    return NextResponse.json({ error: '`templateId` is required' }, { status: 400 });
  if (!reservationNumber)
    return NextResponse.json({ error: '`reservationNumber` is required' }, { status: 400 });

  const redis = getRedis();
  if (!redis) {
    // Without Redis we can't log, but the operator already triggered the
    // WhatsApp send client-side. Don't 500 — return ok with a hint so the
    // UI doesn't show a misleading error.
    return NextResponse.json({ ok: true, logged: false, reason: 'Redis not configured' });
  }

  try {
    const existing = (await redis.get<EmailSendLogEntry[]>(LOG_KEY)) ?? [];
    const entry: EmailSendLogEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      reservationNumber,
      templateId,
      templateLabel: templateLabel || templateId,
      channel: 'whatsapp',
      to,
      subject: '', // WhatsApp has no subject line
      sentAt: new Date().toISOString(),
      sentBy: guard.email,
    };
    await redis.set(LOG_KEY, [...existing, entry]);
    return NextResponse.json({ ok: true, logged: true });
  } catch (err) {
    console.error('[log-guest-message] Failed to append send log:', err);
    return NextResponse.json({ ok: true, logged: false });
  }
}
