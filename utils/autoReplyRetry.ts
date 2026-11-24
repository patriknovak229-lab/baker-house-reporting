/**
 * What to do with a guest message whose automatic handling failed part-way:
 * the urgency check, contact capture, invoice flow or AI draft threw (usually
 * an Anthropic or Beds24 outage).
 *
 *  - 'retry'   → the message is released from `baker:auto-reply:processed`, so
 *                the next poll (≤ 5 min via cron-job.org, ~30 s while the
 *                dashboard is open) runs the whole pipeline on it again.
 *  - 'give-up' → it stays processed and the ops group gets a Telegram asking
 *                someone to answer it by hand.
 *
 * `attempt` counts failures for this message, starting at 1.
 * `sentToGuest` is true when an automatic message already went to the guest
 * during the failed attempt. A retry runs the same steps again, so it could
 * send that message a second time.
 */
export type FailedMessageAction = 'retry' | 'give-up';

export function failedMessageAction(attempt: number, sentToGuest: boolean): FailedMessageAction {
  // Patrik, 24 Nov 2026: a second automatic message reads as a broken bot, so a
  // message that already got a reply is never retried — it becomes a
  // "Message issue" task instead. Otherwise one retry (2 attempts in total).
  if (sentToGuest) return 'give-up';
  return attempt < 2 ? 'retry' : 'give-up';
}
