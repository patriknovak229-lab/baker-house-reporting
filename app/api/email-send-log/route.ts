/**
 * GET /api/email-send-log
 *
 * Returns every guest-facing template email that has been sent, grouped by
 * reservationNumber. The Transactions page fetches this alongside vouchers
 * and additional payments, then merges into each reservation as
 * reservation.emailSendLog so the drawer can show "Last sent: Thank You on 11 May".
 *
 * Append-only audit trail — entries are never edited or deleted.
 * Auth: admin / super / accountant (read-only).
 */

import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { requireRole } from '@/utils/authGuard';
import type { EmailSendLogEntry } from '@/types/emailSendLog';

const KEY = 'baker:email-send-log';

function getRedis(): Redis {
  return new Redis({
    url:   process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });
}

export async function GET() {
  const guard = await requireRole(['admin', 'super', 'accountant', 'viewer']);
  if ('error' in guard) return guard.error;

  const redis = getRedis();
  const entries = (await redis.get<EmailSendLogEntry[]>(KEY)) ?? [];
  return NextResponse.json(entries);
}
