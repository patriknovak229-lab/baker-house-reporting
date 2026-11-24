/**
 * Email backup for technical alerts. Used only when Telegram could not deliver
 * one (utils/telegram.sendTechnicalAlert) or cannot reach the technical chat at
 * all (the daily catch-up's check) — Telegram stays the primary channel.
 *
 * Same SMTP transport as the other senders (STARTTLS on 587). Never throws:
 * this is the last channel, so a failure here can only be logged.
 */
import nodemailer from 'nodemailer';
import { htmlToText } from '@/utils/guestEmail';
import { technicalContacts } from '@/utils/systemAlerts';

export async function sendAlertEmail(subject: string, html: string): Promise<boolean> {
  const to = technicalContacts();
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (to.length === 0 || !user || !pass) {
    console.error('[alert-email] not sent: no recipient (ALERT_EMAIL / ADMIN_EMAILS) or SMTP credentials');
    return false;
  }
  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST ?? 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT ?? '587'),
      secure: false, // STARTTLS on 587
      auth: { user, pass },
    });
    // Telegram's HTML subset (<b>, <i>, <code>) reads fine as plain text once
    // stripped; line breaks are kept with white-space: pre-wrap.
    await transporter.sendMail({
      from: `"Baker House alerts" <${process.env.SMTP_FROM?.trim() || user}>`,
      to: to.join(', '),
      subject,
      text: htmlToText(html),
      html: `<div style="font-family: sans-serif; white-space: pre-wrap">${html}</div>`,
    });
    return true;
  } catch (err) {
    console.error('[alert-email] send failed:', err);
    return false;
  }
}
