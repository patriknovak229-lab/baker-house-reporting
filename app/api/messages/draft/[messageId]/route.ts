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
import { translateReplyToGuest } from '@/utils/translateReply';

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
  /** Czech-first AI drafts: language of `draftText` ('cs') + the guest's
   *  language to translate into on send. Absent on legacy drafts (send as-is). */
  draftLanguage?: string;
  targetLanguage?: string;
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
  /** The incoming guest message this entry is about (for /auto-reply-log review). */
  guestMessage?: string;
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

// Light edit-capture: records when the operator changed the AI's draft, so we
// can later look for patterns (what gets corrected, and how) and fold them
// into the knowledge base. Storage only for now — no analysis pipeline yet.
const EDIT_LOG_KEY = 'baker:auto-reply:edit-log';
const EDIT_LOG_MAX = 500;

interface EditLogEntry {
  beds24MessageId: number;
  bookingId: number;
  reservationNumber: string;
  category: string;
  language: string;
  guestMessage: string;
  aiDraft: string;
  operatorText: string;
  editedAt: string;
}

async function appendEditLog(redis: Redis, entry: EditLogEntry): Promise<void> {
  try {
    const log = (await redis.get<EditLogEntry[]>(EDIT_LOG_KEY)) ?? [];
    const next = [entry, ...log].slice(0, EDIT_LOG_MAX);
    await redis.set(EDIT_LOG_KEY, next);
  } catch (err) {
    console.warn('[messages/draft] edit-log append failed:', err);
  }
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

  let body: { text?: string; preTranslated?: boolean; sourceText?: string } = {};
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

  // Czech-first: translate the (edited) Czech draft into the guest's language
  // before sending. Legacy guest-language drafts (no draftLanguage) send as-is.
  let textToSend = proposedText;
  const draftLanguage = pending.type === 'draft' ? pending.entry.draftLanguage : undefined;
  const targetLanguage = pending.type === 'draft' ? pending.entry.targetLanguage : undefined;
  // `preTranslated` = the operator previewed via "Show translation" and is
  // sending that exact guest-language text → send as-is, don't re-translate.
  const willTranslate =
    !body.preTranslated &&
    draftLanguage === 'cs' && !!targetLanguage && targetLanguage.toLowerCase() !== 'cs';
  if (willTranslate) {
    try {
      textToSend = await translateReplyToGuest(proposedText, targetLanguage as string);
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
        detail: `translate-on-send to ${targetLanguage} failed: ${msg}`,
        decidedAt: new Date().toISOString(),
      });
      return NextResponse.json({ error: `Translation failed: ${msg}` }, { status: 502 });
    }
  }

  let sentMessageId: number | null = null;
  try {
    const result = await sendBeds24Message(pending.entry.bookingId, textToSend);
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
      sentText: textToSend,
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
    sentText: textToSend,
    guestMessage: pending.entry.guestMessageText,
    detail: willTranslate
      ? `${wasEdited ? 'operator edited' : 'approved'} the Czech draft; sent translated to ${targetLanguage}`
      : wasEdited
        ? 'operator edited draft before sending'
        : 'operator approved draft as-is',
    decidedAt: new Date().toISOString(),
  });

  // Light edit-capture: when the operator changed the AI's draft, store the
  // before/after (in the operator's working language) for later analysis.
  const aiDraft = (pending.entry.draftText ?? '').trim();
  const operatorSource = (body.sourceText ?? body.text ?? '').trim();
  if (aiDraft && operatorSource && operatorSource !== aiDraft) {
    await appendEditLog(redis, {
      beds24MessageId: pending.entry.beds24MessageId,
      bookingId: pending.entry.bookingId,
      reservationNumber: pending.entry.reservationNumber,
      category: pending.type === 'draft' ? pending.entry.category : 'other',
      language: pending.entry.language,
      guestMessage: pending.entry.guestMessageText,
      aiDraft,
      operatorText: operatorSource,
      editedAt: new Date().toISOString(),
    });
  }

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
    guestMessage: pending.entry.guestMessageText,
    detail: 'operator dismissed from unread-messages panel',
    decidedAt: new Date().toISOString(),
  });

  return NextResponse.json({ ok: true });
}
