/**
 * "A human is handling this chat" — pauses automatic guest replies for 24 h
 * once the operator has written to the guest themselves.
 *
 * Why: the operator sorts out an issue, the guest says "thank you so much!",
 * and an instant canned "you're welcome, reach out anytime" lands on top of
 * the human conversation. It reads as a bot butting in. While the operator is
 * engaged, replies are still DRAFTED (queued for approval) — just never
 * auto-sent.
 *
 * Two signals, either one pauses:
 *   1. An explicit marker set by the app's own operator send paths (thread
 *      reply, approving a queued draft) — instant, no Beds24 call needed.
 *   2. A host message in the Beds24 thread within the window that WE did not
 *      send automatically — catches replies written straight in Beds24, the
 *      Booking.com extranet or the Airbnb app. Every automatic send is marked
 *      by its Beds24 message id so it doesn't count as the operator.
 */

import type { Redis } from '@upstash/redis';
import type { ConversationMessage } from '@/utils/beds24Conversation';

export const OPERATOR_PAUSE_MS = 24 * 60 * 60 * 1000;
const OPERATOR_PAUSE_SECONDS = OPERATOR_PAUSE_MS / 1000;
/** Auto-sent markers only need to outlive the pause window they're checked in. */
const AUTO_SENT_TTL_SECONDS = 3 * 24 * 60 * 60;

const operatorKey = (bookingId: number | string) => `baker:operator-active:${bookingId}`;
const autoSentKey = (messageId: number | string) => `baker:auto-sent-msg:${messageId}`;

/** The operator just wrote to this booking's guest from the app. */
export async function markOperatorActive(
  redis: Redis | null,
  bookingId: number | string,
): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(operatorKey(bookingId), new Date().toISOString(), { ex: OPERATOR_PAUSE_SECONDS });
  } catch (err) {
    console.warn(`[operatorActivity] mark failed for ${bookingId}:`, err);
  }
}

/** This Beds24 message was sent by an automation, not by a person. */
export async function markAutoSent(
  redis: Redis | null,
  messageId: number | null | undefined,
): Promise<void> {
  if (!redis || messageId == null) return;
  try {
    await redis.set(autoSentKey(messageId), 1, { ex: AUTO_SENT_TTL_SECONDS });
  } catch (err) {
    console.warn(`[operatorActivity] auto-sent mark failed for msg ${messageId}:`, err);
  }
}

/**
 * Has a person written to this guest in the last 24 h? `history` is the
 * booking's recent Beds24 thread (ids + times needed for signal 2); pass []
 * to rely on the explicit marker alone. Fails OPEN to "not active" — a Redis
 * hiccup must not silently stop every auto-reply.
 */
export async function isOperatorActive(
  redis: Redis | null,
  bookingId: number | string,
  history: ConversationMessage[],
  now: Date = new Date(),
): Promise<boolean> {
  if (!redis) return false;
  try {
    if (await redis.get(operatorKey(bookingId))) return true;

    const cutoff = now.getTime() - OPERATOR_PAUSE_MS;
    const recentHost = history.filter((m) => {
      if (m.role !== 'host') return false;
      const t = new Date(m.time).getTime();
      return Number.isFinite(t) && t >= cutoff;
    });
    for (const m of recentHost) {
      // No id → can't prove it was us, so it counts as a person.
      if (m.id == null) return true;
      if (!(await redis.get(autoSentKey(m.id)))) return true;
    }
    return false;
  } catch (err) {
    console.warn(`[operatorActivity] check failed for ${bookingId}:`, err);
    return false;
  }
}
