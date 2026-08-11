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
import { requireRole } from '@/utils/authGuard';
import { readAllEmailSendLog } from '@/utils/emailSendLogStore';

export async function GET() {
  const guard = await requireRole(['admin', 'super', 'accountant', 'viewer']);
  if ('error' in guard) return guard.error;

  const entries = await readAllEmailSendLog();
  return NextResponse.json(entries);
}
