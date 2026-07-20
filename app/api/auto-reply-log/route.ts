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
const EDIT_LOG_KEY = 'baker:auto-reply:edit-log';

/**
 * Graduation thresholds for the per-category readiness table. A category is a
 * candidate to move from review-only to auto-send when the operator has
 * decided on enough of its drafts, sends most of them UNTOUCHED, and rarely
 * throws one away. Tune here — these drive the "verdict" column only, not any
 * send behaviour.
 */
const MIN_DECIDED_SAMPLE = 10; // need at least this many operator decisions
const READY_CLEAN_RATE = 0.85; // ≥85% of sent drafts went out unedited
const READY_DISMISS_RATE = 0.1; // ≤10% of decisions were dismissals
const ALMOST_CLEAN_RATE = 0.7;
const ALMOST_DISMISS_RATE = 0.2;

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
  guestMessage?: string;
  detail?: string;
  decidedAt: string;
}

/** Minimal shape we read from the edit-log for edit-magnitude only. */
interface EditLogEntry {
  category: string;
  aiDraft: string;
  operatorText: string;
}

type CategoryVerdict =
  | 'ready' // meets graduation thresholds — safe to auto-send
  | 'almost' // close; keep reviewing a bit longer
  | 'review' // still needs the operator
  | 'insufficient' // not enough decided drafts to judge
  | 'automated'; // driven by the deterministic flow (invoice) — n/a

interface CategoryStat {
  category: string;
  /** Drafts surfaced for review (queued-draft + queued-other). Context only. */
  surfaced: number;
  /** Operator decisions: approved + edited + dismissed. */
  decided: number;
  approved: number; // sent unedited
  edited: number; // edited before sending
  dismissed: number; // discarded, never sent
  sent: number; // approved + edited
  /** approved / sent — how often a used draft went out untouched. */
  cleanRate: number | null;
  /** dismissed / decided — how often the draft was thrown away. */
  dismissRate: number | null;
  /** Avg word-level change on the drafts that WERE edited (0–1), or null. */
  avgEditSize: number | null;
  verdict: CategoryVerdict;
}

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

// ── Category readiness aggregation ───────────────────────────────────────────

function tokenize(s: string): string[] {
  // Word-level tokens, lower-cased, capped so a pathological draft can't blow
  // up the O(n·m) edit distance below.
  return s.trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 300);
}

/** Classic Levenshtein over token arrays (rolling two-row DP). */
function wordLevenshtein(a: string[], b: string[]): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i, ...new Array(n).fill(0)];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

/** Fraction of words the operator changed (0 = identical, 1 = fully rewritten). */
function wordEditRatio(before: string, after: string): number {
  const a = tokenize(before);
  const b = tokenize(after);
  if (a.length === 0 && b.length === 0) return 0;
  const dist = wordLevenshtein(a, b);
  return Math.min(1, dist / Math.max(a.length, b.length, 1));
}

function verdictFor(
  category: string,
  decided: number,
  cleanRate: number | null,
  dismissRate: number | null,
): CategoryVerdict {
  // Invoice is handled end-to-end by the deterministic flow, not the review
  // queue — its decision counts aren't a graduation signal.
  if (category === 'invoice-request') return 'automated';
  if (decided < MIN_DECIDED_SAMPLE) return 'insufficient';
  if (cleanRate === null || dismissRate === null) return 'insufficient';
  // "other" is a heterogeneous catch-all — never a safe auto-send target no
  // matter how clean the numbers look. Cap it at "review".
  if (category === 'other') return 'review';
  if (cleanRate >= READY_CLEAN_RATE && dismissRate <= READY_DISMISS_RATE) return 'ready';
  if (cleanRate >= ALMOST_CLEAN_RATE && dismissRate <= ALMOST_DISMISS_RATE) return 'almost';
  return 'review';
}

const VERDICT_RANK: Record<CategoryVerdict, number> = {
  ready: 0,
  almost: 1,
  review: 2,
  insufficient: 3,
  automated: 4,
};

function computeCategoryStats(
  log: AutoReplyLogEntry[],
  editLog: EditLogEntry[],
): CategoryStat[] {
  const counts = new Map<
    string,
    { surfaced: number; approved: number; edited: number; dismissed: number }
  >();
  const ensure = (c: string) => {
    let v = counts.get(c);
    if (!v) {
      v = { surfaced: 0, approved: 0, edited: 0, dismissed: 0 };
      counts.set(c, v);
    }
    return v;
  };

  for (const e of log) {
    const c = e.category || 'other';
    const a = ensure(c);
    switch (e.action) {
      case 'queued-draft':
      case 'queued-other':
        a.surfaced++;
        break;
      case 'approved':
        a.approved++;
        break;
      case 'edited-approved':
        a.edited++;
        break;
      case 'dismissed':
        a.dismissed++;
        break;
      default:
        break; // sent / errored / skipped-* don't factor into review stats
    }
  }

  // Average edit magnitude per category, from the before/after edit-log.
  const editSizes = new Map<string, number[]>();
  for (const ed of editLog) {
    if (!ed || !ed.aiDraft || !ed.operatorText) continue;
    const c = ed.category || 'other';
    const arr = editSizes.get(c) ?? [];
    arr.push(wordEditRatio(ed.aiDraft, ed.operatorText));
    editSizes.set(c, arr);
  }

  const stats: CategoryStat[] = [];
  for (const [category, a] of counts) {
    const decided = a.approved + a.edited + a.dismissed;
    const sent = a.approved + a.edited;
    const cleanRate = sent > 0 ? a.approved / sent : null;
    const dismissRate = decided > 0 ? a.dismissed / decided : null;
    const sizes = editSizes.get(category) ?? [];
    const avgEditSize = sizes.length
      ? sizes.reduce((s, x) => s + x, 0) / sizes.length
      : null;
    stats.push({
      category,
      surfaced: a.surfaced,
      decided,
      approved: a.approved,
      edited: a.edited,
      dismissed: a.dismissed,
      sent,
      cleanRate,
      dismissRate,
      avgEditSize,
      verdict: verdictFor(category, decided, cleanRate, dismissRate),
    });
  }

  // Most-ready first, then by clean rate, then by sample size.
  stats.sort((x, y) => {
    if (VERDICT_RANK[x.verdict] !== VERDICT_RANK[y.verdict]) {
      return VERDICT_RANK[x.verdict] - VERDICT_RANK[y.verdict];
    }
    if ((y.cleanRate ?? -1) !== (x.cleanRate ?? -1)) {
      return (y.cleanRate ?? -1) - (x.cleanRate ?? -1);
    }
    return y.decided - x.decided;
  });
  return stats;
}

export async function GET() {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  const redis = getRedis();
  if (!redis) {
    return NextResponse.json({ error: 'Redis not configured' }, { status: 503 });
  }

  const [log, lastPoll, invoiceRequests, editLog] = await Promise.all([
    redis.get<AutoReplyLogEntry[]>(LOG_KEY).then((v) => v ?? []),
    redis.get<number>(LAST_POLL_KEY),
    redis.get<InvoiceRequest[]>(INVOICE_REQUESTS_KEY).then((v) => v ?? []),
    redis.get<EditLogEntry[]>(EDIT_LOG_KEY).then((v) => v ?? []),
  ]);

  // Per-category readiness — computed over the FULL retained log (not the
  // 100-row UI slice) so the graduation call is based on all decisions we have.
  const categoryStats = computeCategoryStats(log, editLog);

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
    categoryStats,
    // How many log rows the stats were computed over (the retained window).
    statsWindow: log.length,
    activeInvoiceRequests,
    allInvoiceRequests: invoiceRequests,
  });
}
