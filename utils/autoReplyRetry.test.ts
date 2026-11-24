import { describe, expect, it } from 'vitest';
import { failedMessageAction } from './autoReplyRetry';

describe('failedMessageAction', () => {
  it('retries a message once when nothing reached the guest', () => {
    expect(failedMessageAction(1, false)).toBe('retry');
    expect(failedMessageAction(2, false)).toBe('give-up');
    expect(failedMessageAction(5, false)).toBe('give-up');
  });

  it('never retries once an automatic message went to the guest', () => {
    expect(failedMessageAction(1, true)).toBe('give-up');
    expect(failedMessageAction(2, true)).toBe('give-up');
  });
});
