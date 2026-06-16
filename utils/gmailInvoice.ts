import { google } from 'googleapis';
import type { gmail_v1 } from 'googleapis';
import type { Redis } from '@upstash/redis';
import type { GmailInvoiceToken } from '@/app/api/accounting/connect-gmail/callback/route';

const TOKEN_KEY = 'baker:gmail-invoice-token';

export type MessagePart = {
  mimeType?: string | null;
  body?: { data?: string | null; attachmentId?: string | null; size?: number | null } | null;
  filename?: string | null;
  parts?: MessagePart[] | null;
};

/** Recursively decode email body text (HTML preferred over plain text) */
export function extractBodyText(part: MessagePart): string {
  if (part.body?.data) {
    try {
      const b64 = part.body.data.replace(/-/g, '+').replace(/_/g, '/');
      return Buffer.from(b64, 'base64').toString('utf-8');
    } catch { return ''; }
  }
  const sub = part.parts ?? [];
  const html = sub.find((p) => p.mimeType === 'text/html');
  if (html) return extractBodyText(html);
  const plain = sub.find((p) => p.mimeType === 'text/plain');
  if (plain) return extractBodyText(plain);
  for (const p of sub) {
    const text = extractBodyText(p);
    if (text) return text;
  }
  return '';
}

/**
 * Extract candidate PDF URLs from HTML/text body.
 * Matches URLs ending in .pdf (optionally with query string) or containing
 * well-known query parameters that trigger PDF downloads.
 */
export function extractPdfUrls(body: string): string[] {
  const PATTERN =
    /https?:\/\/[^\s"'<>)\\]+(?:\.pdf(?:[?#][^\s"'<>)\\]*)?|[?&][^=\s"'<>)\\]*=(?:pdf|download)[^\s"'<>)\\]*)/gi;
  return [...new Set(body.match(PATTERN) ?? [])];
}

/**
 * Attempt to HTTP-GET a URL and return its bytes if the response is a valid PDF.
 * Returns null for auth-gated pages, non-PDF responses, or network errors.
 */
export async function tryFetchPdf(url: string): Promise<Buffer | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; InvoiceBot/1.0)' },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    // Verify PDF magic bytes — rejects HTML login pages that return 200
    if (buf.slice(0, 4).toString('ascii') !== '%PDF') return null;
    return buf;
  } catch {
    return null;
  }
}

/**
 * Build a Gmail client for the connected invoice account.
 * Returns a structured error (mirroring the requireRole guard shape) when the
 * account isn't connected or the stored refresh token can no longer be refreshed.
 */
export async function createInvoiceGmailClient(
  redis: Redis,
): Promise<{ gmail: gmail_v1.Gmail } | { error: string; status: number }> {
  const stored = (await redis.get(TOKEN_KEY)) as GmailInvoiceToken | null;
  if (!stored?.refreshToken) {
    return { error: 'Invoice Gmail account not connected. Connect it in the Accounting settings.', status: 401 };
  }

  const clientId = process.env.AUTH_GOOGLE_ID;
  const clientSecret = process.env.AUTH_GOOGLE_SECRET;
  if (!clientId || !clientSecret) {
    return { error: 'Google OAuth credentials not configured', status: 503 };
  }

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({ refresh_token: stored.refreshToken });
  try {
    await oauth2.getAccessToken();
  } catch {
    return { error: 'Failed to refresh Gmail token. The connection may have expired — please reconnect.', status: 401 };
  }

  return { gmail: google.gmail({ version: 'v1', auth: oauth2 }) };
}

/**
 * Fetch the first invoice PDF from a single Gmail message.
 * Layer 1: a real PDF attachment. Layer 2: a PDF download link in the body
 * (used by portal-notification emails). Returns null if neither yields a PDF.
 */
export async function fetchInvoicePdfForMessage(
  gmail: gmail_v1.Gmail,
  messageId: string,
): Promise<{ fileName: string; buffer: Buffer } | null> {
  const msgRes = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });

  // ── Layer 1: PDF attachment ──
  const parts = (msgRes.data.payload?.parts ?? []) as MessagePart[];
  for (const part of parts) {
    if (part.filename && part.filename.toLowerCase().endsWith('.pdf') && part.body?.attachmentId) {
      const attRes = await gmail.users.messages.attachments.get({
        userId: 'me', messageId, id: part.body.attachmentId,
      });
      const data = attRes.data.data ?? '';
      if (data) {
        const buffer = Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
        return { fileName: part.filename, buffer };
      }
    }
  }

  // ── Layer 2: PDF download link in the body ──
  const bodyText = extractBodyText((msgRes.data.payload ?? {}) as MessagePart);
  for (const url of extractPdfUrls(bodyText).slice(0, 5)) {
    const pdfBuf = await tryFetchPdf(url);
    if (!pdfBuf) continue;
    const rawName = url.split('/').pop()?.split('?')[0]?.split('#')[0] ?? '';
    const fileName = /\.pdf$/i.test(rawName) ? rawName : `invoice-${messageId}.pdf`;
    return { fileName, buffer: pdfBuf };
  }

  return null;
}
