/**
 * POST /api/auto-reply-log/recategorize
 *
 * Operator correction: reassign the category of a message's log entries (the
 * detector sometimes drops a real category into `other`). Updates EVERY log row
 * that shares the given beds24MessageId — the `queued-draft` creation row and
 * the decision row — so the per-category readiness stats reflect the fix.
 * Keeps the original category in `recategorizedFrom` for traceability.
 *
 * Only touches the audit log (the stats source); it does not re-send anything.
 * Admin/super only.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { readAllAutoReplyLog, writeAllAutoReplyLog } from '@/utils/autoReplyLogStore';

const VALID_CATEGORIES = new Set([
  'parking',
  'wifi',
  'minibar',
  'early-checkin',
  'late-checkout',
  'invoice-request',
  'acknowledgement',
  'air-conditioning',
  'bathroom',
  'checkout',
  'other',
]);

interface LogEntry {
  id: string;
  beds24MessageId: number;
  category: string;
  recategorizedFrom?: string;
  [k: string]: unknown;
}

export async function POST(req: NextRequest) {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  let body: { beds24MessageId?: unknown; category?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const beds24MessageId = Number(body.beds24MessageId);
  const category = typeof body.category === 'string' ? body.category : '';
  if (!Number.isFinite(beds24MessageId)) {
    return NextResponse.json({ error: '`beds24MessageId` (number) required' }, { status: 400 });
  }
  if (!VALID_CATEGORIES.has(category)) {
    return NextResponse.json({ error: `Unknown category '${category}'` }, { status: 400 });
  }

  const log = await readAllAutoReplyLog<LogEntry>();
  let updated = 0;
  const next = log.map((e) => {
    if (e.beds24MessageId === beds24MessageId && e.category !== category) {
      updated += 1;
      return { ...e, category, recategorizedFrom: e.recategorizedFrom ?? e.category };
    }
    return e;
  });

  if (updated > 0) await writeAllAutoReplyLog(next);
  return NextResponse.json({ ok: true, updated });
}
