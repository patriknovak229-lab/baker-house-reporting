/**
 * SMTP outcome handling for invoice sends — the bit that can't be tested by
 * hand (you can't ask Gmail for a 451 on demand).
 *
 * The incident this covers: a real send returned
 *   "Message failed: 451-4.3.0 Mail server temporarily rejected message"
 * and the UI reported a hard failure, but the guest received the invoice.
 * Nodemailer only produces that error from the reply to the END of DATA, i.e.
 * the server already had the whole message.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Reservation } from '@/types/reservation';

const { sendMail } = vi.hoisted(() => ({ sendMail: vi.fn() }));
// Stands in for headless Chromium: the "PDF" is just the HTML bytes.
const { generatePDF } = vi.hoisted(() => ({ generatePDF: vi.fn(async (html: string) => Buffer.from(html)) }));

vi.mock('nodemailer', () => ({ default: { createTransport: () => ({ sendMail }) } }));
vi.mock('@/utils/pdfGenerate', () => ({ generatePDF }));

import { sendInvoiceEmail } from './invoiceSend';

const res = {
  price: 25000,
  room: 'K.201',
  firstName: 'Jan',
  lastName: 'Novák',
  numberOfNights: 4,
  numberOfGuests: 2,
  checkInDate: '2026-08-01',
  checkOutDate: '2026-08-05',
  reservationNumber: 'BH-1001',
  invoiceStatus: 'Issued',
  invoiceData: {
    companyName: 'ACME s.r.o.',
    companyAddress: 'Street 1, Brno',
    ico: '12345678',
    vatNumber: '',
    billingEmail: 'guest@example.com',
  },
} as unknown as Reservation;

/** Mimics nodemailer's `_formatError` output shape. */
function smtpError(response: string, command: string, code = 'EMESSAGE'): Error {
  const err = new Error(`Message failed: ${response}`) as Error & Record<string, unknown>;
  err.code = code;
  err.response = response;
  err.responseCode = Number((response.match(/^\d+/) ?? ['0'])[0]);
  err.command = command;
  return err;
}

const GMAIL_451 =
  '451-4.3.0 Mail server temporarily rejected message. For more information, go to 451 4.3.0 https://support.google.com/a/answer/3221692 6a1803df08f44-90c5f2905cbsm40113826d6.23 - gsmtp';

beforeEach(() => {
  sendMail.mockReset();
  generatePDF.mockClear();
  process.env.SMTP_USER = 'invoices@bakerhouseapartments.cz';
  process.env.SMTP_PASS = 'app-password';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('sendInvoiceEmail SMTP outcomes', () => {
  it('reports a confirmed send', async () => {
    sendMail.mockResolvedValue({ response: '250 2.0.0 OK' });
    const result = await sendInvoiceEmail(res);
    expect(result).toMatchObject({ invoiceNumber: 'INV-1001', sentTo: 'guest@example.com', outcome: 'sent', attempts: 1 });
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it('treats a 451 at the end of DATA as deferred, not failed, and never re-sends it', async () => {
    sendMail.mockRejectedValue(smtpError(GMAIL_451, 'DATA'));
    const result = await sendInvoiceEmail(res);
    expect(result.outcome).toBe('deferred');
    expect(result.deferral).toContain('451-4.3.0');
    // The server already had the message — a retry here is what duplicates it.
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure that happened before the body went out', async () => {
    sendMail
      .mockRejectedValueOnce(smtpError('421 4.7.0 Try again later', 'RCPT TO', 'EENVELOPE'))
      .mockResolvedValueOnce({ response: '250 2.0.0 OK' });

    vi.useFakeTimers();
    const pending = sendInvoiceEmail(res);
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result).toMatchObject({ outcome: 'sent', attempts: 2 });
    expect(sendMail).toHaveBeenCalledTimes(2);
    // Same message both times: one PDF render, one Message-ID, so a recipient
    // that somehow gets both copies can collapse them.
    expect(generatePDF).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0].messageId).toBe(sendMail.mock.calls[1][0].messageId);
  });

  it('gives up after the bounded number of attempts', async () => {
    sendMail.mockRejectedValue(smtpError('421 4.7.0 Try again later', 'RCPT TO', 'EENVELOPE'));

    vi.useFakeTimers();
    const pending = sendInvoiceEmail(res);
    const assertion = expect(pending).rejects.toThrow(/421/);
    await vi.runAllTimersAsync();
    await assertion;

    expect(sendMail).toHaveBeenCalledTimes(3);
  });

  it('does not retry a permanent rejection', async () => {
    sendMail.mockRejectedValue(smtpError('550 5.1.1 No such user', 'RCPT TO', 'EENVELOPE'));
    await expect(sendInvoiceEmail(res)).rejects.toThrow(/550/);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });
});

describe('sendInvoiceEmail payment QR', () => {
  it("asks for the modified version's total, not the booking price", async () => {
    sendMail.mockResolvedValue({ response: '250 2.0.0 OK' });
    await sendInvoiceEmail(res, {
      includeQR: true,
      modification: {
        id: 'm1',
        dateRanges: [{ from: '2026-08-01', to: '2026-08-05' }],
        numberOfNights: 4,
        numberOfGuests: 2,
        room: 'K.201',
        amount: 18000,
        createdAt: '2026-08-01T00:00:00.000Z',
      },
    });
    const html = generatePDF.mock.calls[0][0];
    expect(html).toContain((18000).toLocaleString('cs-CZ'));
    expect(html).not.toContain((25000).toLocaleString('cs-CZ'));
  });
});
