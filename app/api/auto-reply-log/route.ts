/**
 * GET /api/auto-reply-log
 *
 * Returns the auto-reply pipeline's audit trail + the active invoice
 * requests + the last-poll timestamp so the operator can verify the
 * webhook is firing and see what the categoriser / field extractor are
 * deciding. Admin/super only.
 */

import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { requireRole } from '@/utils/authGuard';
import type { InvoiceRequest } from '@/types/invoiceRequest';

const LOG_KEY = 'baker:auto-reply:log';
const LAST_POLL_KEY = 'baker:auto-reply:last-poll';
const INVOICE_REQUESTS_KEY = 'baker:invoice-requests';

interface AutoReplyLogEntry {
  id: string;
  beds24MessageId: number;
  beds24SentMessageId: number | null;
  bookingId: number;
  reservationNumber: string;
  category: string;
  confidence: number;
  language: string;
  action: string;
  sentText: string | null;
  detail?: string;
  decidedAt: string;
}

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export async function GET() {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  const redis = getRedis();
  if (!redis) {
    return NextResponse.json({ error: 'Redis not configured' }, { status: 503 });
  }

  const [log, lastPoll, invoiceRequests] = await Promise.all([
    redis.get<AutoReplyLogEntry[]>(LOG_KEY).then((v) => v ?? []),
    redis.get<number>(LAST_POLL_KEY),
    redis.get<InvoiceRequest[]>(INVOICE_REQUESTS_KEY).then((v) => v ?? []),
  ]);

  // Newest first; cap to last 100 for the UI
  const sortedLog = [...log]
    .sort((a, b) => new Date(b.decidedAt).getTime() - new Date(a.decidedAt).getTime())
    .slice(0, 100);

  // Highlight invoice requests that are awaiting-info (most actionable
  // state for the operator to know about)
  const activeInvoiceRequests = invoiceRequests.filter((r) =>
    ['awaiting-info', 'pending'].includes(r.status),
  );

  return NextResponse.json({
    lastPollAt: lastPoll ? new Date(lastPoll).toISOString() : null,
    logTotal: log.length,
    log: sortedLog,
    activeInvoiceRequests,
    allInvoiceRequests: invoiceRequests,
  });
}
