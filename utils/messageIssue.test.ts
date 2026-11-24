import { describe, expect, it } from 'vitest';
import { appendMessageIssue, buildMessageIssue, messageIssueId } from './messageIssue';

const base = {
  beds24MessageId: 4242,
  guestMessage: 'Where   do we\npark the car?',
  reason: 'Anthropic 529 overloaded',
  attempts: 2,
  today: '2026-11-24',
  nowIso: '2026-11-24T12:00:00.000Z',
};

describe('buildMessageIssue', () => {
  it('asks for a manual answer when nothing reached the guest', () => {
    const issue = buildMessageIssue({ ...base, sentToGuest: false });
    expect(issue.id).toBe(messageIssueId(4242));
    expect(issue.category).toBe('problem');
    expect(issue.actionableDate).toBe('2026-11-24');
    expect(issue.text).toContain('"Where do we park the car?"');
    expect(issue.text).toContain('failed 2×');
    expect(issue.text).toContain('Answer it by hand');
  });

  it('says nothing will be re-sent when a reply already went out', () => {
    const issue = buildMessageIssue({ ...base, sentToGuest: true });
    expect(issue.text).toContain('an automatic reply went out');
    expect(issue.text).toContain('nothing will be re-sent');
    expect(issue.text).not.toContain('Answer it by hand');
  });
});

describe('appendMessageIssue', () => {
  it('adds one task per guest message', () => {
    const issue = buildMessageIssue({ ...base, sentToGuest: false });
    const once = appendMessageIssue([], issue);
    expect(once).toHaveLength(1);
    expect(appendMessageIssue(once!, issue)).toBeNull();
  });
});
