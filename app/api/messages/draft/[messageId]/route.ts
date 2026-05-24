/**
 * POST   /api/messages/draft/[messageId]  — approve a pending draft (optionally edited) and send it.
 * DELETE /api/messages/draft/[messageId]  — dismiss a pending draft or queued `other` entry.
 *
 * Both endpoints operate on the per-message entries the auto-reply
 * pipeline stashed in the Redis hashes `baker:auto-reply:pending-drafts`
 * (drafted follow-ups) and `baker:auto-reply:pending-others` (messages
 * that classified as `other` and need operator handling). On approve,
 * the chosen text is sent via Beds24 and the entry is removed from both
 * hashes. On dismiss, the entry is removed without sending.
 *
 * Audit trail: every action appends to `baker:auto-reply:log` so the
 * /auto-reply-log view reflects operator decisions alongside automated
 * ones.
 */

import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { requireRole } from '@/utils/authGuard';
import { sendBeds24Message } from '@/utils/beds24Messages';

const PENDING_DRAFTS_KEY = 'baker:auto-reply:pending-drafts';
const PENDING_OTHERS_KEY = 'baker:auto-reply:pending-others';
const LOG_KEY = 'baker:auto-reply:log';
const LOG_MAX_ENTRIES = 500;

interface PendingDraft {
  beds24MessageId: number;
  bookingId: number;
  reservationNumber: string;
  guestMessageText: string;
  guestMessageTime: string;
  category: string;
  confidence: number;
  language: string;
  draftText: string;
  createdAt: string;
}

// No category — `other` is implicit.
type PendingOther = Omit<PendingDraft, 'category'>;

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

function getRedis(): Redis {
  return new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });
}

function parseEntry<T>(raw: unknown): T | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
  return raw as T;
}

async function readPending(
  redis: Redis,
  messageId: string,
): Promise<
  | { type: 'draft'; entry: PendingDraft }
  | { type: 'other'; entry: PendingOther }
  | null
> {
  const draftRaw = await redis.hget<unknown>(PENDING_DRAFTS_KEY, messageId);
  const draft = parseEntry<PendingDraft>(draftRaw);
  if (draft) return { type: 'draft', entry: draft };
  const otherRaw = await redis.hget<unknown>(PENDING_OTHERS_KEY, messageId);
  const other = parseEntry<PendingOther>(otherRaw);
  if (other) return { type: 'other', entry: other };
  return null;
}

async function removePending(redis: Redis, messageId: string): Promise<void> {
  // Try both — only one will match, the other is a no-op.
  await Promise.all([
    redis.hdel(PENDING_DRAFTS_KEY, messageId),
    redis.hdel(PENDING_OTHERS_KEY, messageId),
  ]);
}

async function appendLog(redis: Redis, entry: AutoReplyLogEntry): Promise<void> {
  const log = (await redis.get<AutoReplyLogEntry[]>(LOG_KEY)) ?? [];
  const next = [entry, ...log].slice(0, LOG_MAX_ENTRIES);
  await redis.set(LOG_KEY, next);
}

function makeLogId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── POST: approve & send ─────────────────────────────────────────────────────
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ messageId: string }> },
) {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  const { messageId } = await params;
  if (!messageId) {
    return NextResponse.json({ error: 'messageId required' }, { status: 400 });
  }

  let body: { text?: string } = {};
  try {
    body = await req.json();
  } catch {
    // Empty body is acceptable — means "approve the draft as-is".
  }

  const redis = getRedis();
  const pending = await readPending(redis, messageId);
  if (!pending) {
    return NextResponse.json(
      { error: 'No pending entry for this messageId' },
      { status: 404 },
    );
  }

  // Choose the text to send: explicit body override → existing draft.
  // For `other` entries the draft may be empty; require body.text in that case.
  const proposedText = (body.text ?? pending.entry.draftText ?? '').trim();
  if (!proposedText) {
    return NextResponse.json(
      { error: 'No text to send — provide `text` in the request body' },
      { status: 400 },
    );
  }

  const wasEdited =
    body.text !== undefined &&
    body.text.trim() !== (pending.entry.draftText ?? '').trim();

  let sentMessageId: number | null = null;
  try {
    const result = await sendBeds24Message(pending.entry.bookingId, proposedText);
    sentMessageId = result.messageId;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await appendLog(redis, {
      id: makeLogId(),
      beds24MessageId: pending.entry.beds24MessageId,
      beds24SentMessageId: null,
      bookingId: pending.entry.bookingId,
      reservationNumber: pending.entry.reservationNumber,
      category: pending.type === 'draft' ? pending.entry.category : 'other',
      confidence: pending.entry.confidence,
      language: pending.entry.language,
      action: 'errored',
      sentText: proposedText,
      detail: `operator approval send failed: ${msg}`,
      decidedAt: new Date().toISOString(),
    });
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  await removePending(redis, messageId);
  await appendLog(redis, {
    id: makeLogId(),
    beds24MessageId: pending.entry.beds24MessageId,
    beds24SentMessageId: sentMessageId,
    bookingId: pending.entry.bookingId,
    reservationNumber: pending.entry.reservationNumber,
    category: pending.type === 'draft' ? pending.entry.category : 'other',
    confidence: pending.entry.confidence,
    language: pending.entry.language,
    action: wasEdited ? 'edited-approved' : 'approved',
    sentText: proposedText,
    detail: wasEdited ? 'operator edited draft before sending' : 'operator approved draft as-is',
    decidedAt: new Date().toISOString(),
  });

  return NextResponse.json({ ok: true, messageId: sentMessageId });
}

// ── DELETE: dismiss ──────────────────────────────────────────────────────────
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ messageId: string }> },
) {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  const { messageId } = await params;
  if (!messageId) {
    return NextResponse.json({ error: 'messageId required' }, { status: 400 });
  }

  const redis = getRedis();
  const pending = await readPending(redis, messageId);
  if (!pending) {
    return NextResponse.json(
      { error: 'No pending entry for this messageId' },
      { status: 404 },
    );
  }

  await removePending(redis, messageId);
  await appendLog(redis, {
    id: makeLogId(),
    beds24MessageId: pending.entry.beds24MessageId,
    beds24SentMessageId: null,
    bookingId: pending.entry.bookingId,
    reservationNumber: pending.entry.reservationNumber,
    category: pending.type === 'draft' ? pending.entry.category : 'other',
    confidence: pending.entry.confidence,
    language: pending.entry.language,
    action: 'dismissed',
    sentText: null,
    detail: 'operator dismissed from unread-messages panel',
    decidedAt: new Date().toISOString(),
  });

  return NextResponse.json({ ok: true });
}
