/**
 * POST /api/sms/send — send a one-way SMS to a guest (admin/super).
 *
 * Unlike the WhatsApp deeplink flow (which the operator completes by hand
 * in WhatsApp), this route actually delivers the message via Twilio, then
 * writes the audit entry itself — same SEND-and-LOG contract as the email
 * route. The log lands in `baker:email-send-log` (channel 'sms') so it
 * shows under the drawer's messaging pills alongside Email / WhatsApp.
 *
 * Body: { reservationNumber, phone, text, templateId?, templateLabel? }
 * Returns: { ok, sid, status, to } — `to` is the normalized E.164 number.
 */

import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { requireRole } from '@/utils/authGuard';
import { sendSms, smsConfigured } from '@/utils/sms';
import { toE164 } from '@/utils/phone';
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

  if (!smsConfigured()) {
    return NextResponse.json(
      {
        error:
          'SMS is not configured. Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_MESSAGING_SERVICE_SID (or TWILIO_SMS_SENDER) to the environment.',
      },
      { status: 503 },
    );
  }

  let body: {
    reservationNumber?: string;
    phone?: string;
    text?: string;
    templateId?: string;
    templateLabel?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const reservationNumber = body.reservationNumber?.trim();
  const text = body.text?.trim();
  const to = toE164(body.phone);

  if (!reservationNumber) {
    return NextResponse.json({ error: 'reservationNumber is required' }, { status: 400 });
  }
  if (!text) {
    return NextResponse.json({ error: 'Message text is empty' }, { status: 400 });
  }
  if (!to) {
    return NextResponse.json(
      { error: `Couldn't read "${body.phone ?? ''}" as a valid phone number` },
      { status: 400 },
    );
  }

  // ── Send via Twilio ───────────────────────────────────────────────
  let sid: string;
  let status: string;
  try {
    const result = await sendSms(to, text);
    sid = result.sid;
    status = result.status;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'SMS send failed';
    console.error('[sms/send] Twilio send failed:', err);
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  // ── Audit log (best-effort — the SMS already went out) ────────────
  const redis = getRedis();
  if (redis) {
    try {
      const existing = (await redis.get<EmailSendLogEntry[]>(LOG_KEY)) ?? [];
      const entry: EmailSendLogEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        reservationNumber,
        templateId: body.templateId?.trim() || 'sms',
        templateLabel: body.templateLabel?.trim() || 'SMS',
        channel: 'sms',
        to,
        subject: '',
        sentAt: new Date().toISOString(),
        sentBy: guard.email,
      };
      await redis.set(LOG_KEY, [...existing, entry]);
    } catch (logErr) {
      console.warn('[sms/send] audit log append failed:', logErr);
    }
  }

  return NextResponse.json({ ok: true, sid, status, to });
}
