import { afterEach, describe, expect, it } from 'vitest';
import { invoiceAlertChatId, pricingChatId, technicalChatId } from './telegram';

const saved = {
  pricing: process.env.TELEGRAM_PRICING_CHAT_ID,
  ops: process.env.TELEGRAM_CHAT_ID,
};

afterEach(() => {
  if (saved.pricing === undefined) delete process.env.TELEGRAM_PRICING_CHAT_ID;
  else process.env.TELEGRAM_PRICING_CHAT_ID = saved.pricing;
  if (saved.ops === undefined) delete process.env.TELEGRAM_CHAT_ID;
  else process.env.TELEGRAM_CHAT_ID = saved.ops;
});

describe('invoice manual-send alert destination', () => {
  it('goes to the price-parity chat, not the ops group', () => {
    process.env.TELEGRAM_PRICING_CHAT_ID = '111';
    process.env.TELEGRAM_CHAT_ID = '222';
    expect(invoiceAlertChatId()).toBe('111');
    expect(invoiceAlertChatId()).toBe(pricingChatId());
  });
});

describe('technical alert destination', () => {
  it('goes to the price-parity chat, not the ops group', () => {
    process.env.TELEGRAM_PRICING_CHAT_ID = '111';
    process.env.TELEGRAM_CHAT_ID = '222';
    expect(technicalChatId()).toBe('111');
  });

  it('falls back to the ops group while no technical chat is configured', () => {
    delete process.env.TELEGRAM_PRICING_CHAT_ID;
    process.env.TELEGRAM_CHAT_ID = '222';
    expect(technicalChatId()).toBe('222');
  });
});
