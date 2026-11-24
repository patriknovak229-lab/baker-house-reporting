import type { Issue } from "@/types/reservation";

/**
 * "Message issue" — a guest message whose automatic handling failed and was
 * given up on (utils/autoReplyRetry). It lands as a red Pending task on the
 * reservation in the Transactions overview instead of a retry, because a
 * repeated automatic message reads as a bot that isn't working.
 */

/** One task per guest message: a repeated give-up finds this id and adds nothing. */
export function messageIssueId(beds24MessageId: number): string {
  return `message-issue-${beds24MessageId}`;
}

export function buildMessageIssue(args: {
  beds24MessageId: number;
  guestMessage: string;
  reason: string;
  attempts: number;
  sentToGuest: boolean;
  today: string;
  nowIso: string;
}): Issue {
  const quote = args.guestMessage.replace(/\s+/g, " ").trim();
  const shortQuote = quote.length > 120 ? `${quote.slice(0, 117)}…` : quote;
  const reason = args.reason.replace(/\s+/g, " ").trim().slice(0, 200) || "unknown error";
  const text = args.sentToGuest
    ? `Message issue: an automatic reply went out to "${shortQuote}", but a later step failed (${reason}). Check the conversation; nothing will be re-sent.`
    : `Message issue: the guest wrote "${shortQuote}" and automatic handling failed ${args.attempts}× (${reason}). Answer it by hand.`;
  return {
    id: messageIssueId(args.beds24MessageId),
    category: "problem",
    text,
    actionableDate: args.today,
    resolved: false,
    createdAt: args.nowIso,
  };
}

/** Adds the task unless this message already has one (resolved or not). */
export function appendMessageIssue(existing: Issue[], issue: Issue): Issue[] | null {
  if (existing.some((i) => i.id === issue.id)) return null;
  return [...existing, issue];
}
