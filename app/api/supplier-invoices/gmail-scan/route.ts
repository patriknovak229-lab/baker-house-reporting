import { NextResponse } from 'next/server';
import { google } from 'googleapis';
import { requireRole } from '@/utils/authGuard';
import { readAllSupplierInvoices } from '@/utils/supplierInvoicesStore';
import { readGmailInvoiceToken } from '@/utils/gmailInvoiceTokenStore';

interface GmailAttachment {
  messageId: string;
  subject: string;
  from: string;
  date: string;
  attachmentId: string;
  attachmentName: string;
  attachmentSize: number;
  /** base64url-encoded bytes of the attachment */
  data: string;
  /** 'email' for real attachments, 'portal' for PDFs fetched from a body link */
  sourceType: 'email' | 'portal';
}

type MessagePart = {
  mimeType?: string | null;
  body?: { data?: string | null; attachmentId?: string | null; size?: number | null } | null;
  filename?: string | null;
  parts?: MessagePart[] | null;
};

/** Recursively decode email body text (HTML preferred over plain text) */
function extractBodyText(part: MessagePart): string {
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
function extractPdfUrls(body: string): string[] {
  const PATTERN =
    /https?:\/\/[^\s"'<>)\\]+(?:\.pdf(?:[?#][^\s"'<>)\\]*)?|[?&][^=\s"'<>)\\]*=(?:pdf|download)[^\s"'<>)\\]*)/gi;
  return [...new Set(body.match(PATTERN) ?? [])];
}

/** Why an email produced no invoice PDF — shown to the user after the scan */
type SkipReason = 'no_pdf' | 'login' | 'expired' | 'unreachable' | 'not_pdf';

/** Most informative first, when an email's links fail for different reasons */
const REASON_PRIORITY: SkipReason[] = ['login', 'expired', 'unreachable', 'not_pdf', 'no_pdf'];

/** Emails processed per scan (each costs Gmail API calls + link fetches); the rest wait for the next scan */
const MAX_NEW_MESSAGES = 150;

/**
 * HTTP-GET a URL and return its bytes if the response is a valid PDF, otherwise
 * why not: a login page (auth-gated portal such as the Alza account), an expired
 * link (404/410), an unreachable host / timeout, or some other non-PDF response.
 */
async function tryFetchPdf(url: string): Promise<{ pdf: Buffer } | { reason: SkipReason }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; InvoiceBot/1.0)' },
    });
    clearTimeout(timer);
    if (res.status === 401 || res.status === 403) return { reason: 'login' };
    if (res.status === 404 || res.status === 410) return { reason: 'expired' };
    if (!res.ok) return { reason: 'unreachable' };
    const buf = Buffer.from(await res.arrayBuffer());
    // Verify PDF magic bytes — rejects HTML login pages that return 200
    if (buf.slice(0, 4).toString('ascii') !== '%PDF') {
      return { reason: (res.headers.get('content-type') ?? '').includes('text/html') ? 'login' : 'not_pdf' };
    }
    return { pdf: buf };
  } catch {
    return { reason: 'unreachable' };
  }
}

export async function POST() {
  const guard = await requireRole(['admin']);
  if ('error' in guard) return guard.error;

  const label = process.env.GMAIL_INVOICE_LABEL;
  if (!label) return NextResponse.json({ error: 'GMAIL_INVOICE_LABEL not configured' }, { status: 503 });

  // Load the stored OAuth token for the invoice Gmail account
  const stored = await readGmailInvoiceToken();
  if (!stored?.refreshToken) {
    return NextResponse.json(
      { error: 'Invoice Gmail account not connected. Please connect it in the Accounting settings.' },
      { status: 401 }
    );
  }

  const clientId = process.env.AUTH_GOOGLE_ID;
  const clientSecret = process.env.AUTH_GOOGLE_SECRET;
  if (!clientId || !clientSecret) {
    return NextResponse.json({ error: 'Google OAuth credentials not configured' }, { status: 503 });
  }

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({ refresh_token: stored.refreshToken });

  try {
    await oauth2.getAccessToken();
  } catch {
    return NextResponse.json(
      { error: 'Failed to refresh Gmail token. The connection may have expired — please reconnect.' },
      { status: 401 }
    );
  }

  const gmail = google.gmail({ version: 'v1', auth: oauth2 });

  // Load already-imported Gmail message IDs to avoid duplicates
  const existing = await readAllSupplierInvoices();
  const importedIds = new Set(existing.map((inv) => inv.gmailMessageId).filter(Boolean));

  // Fetch ALL emails in the configured label (not just the newest page, and not just
  // those with PDF attachments — portal-notification emails have no attachment but
  // contain a download link in the body). Only ids are listed here; cheap.
  const messages: { id?: string | null }[] = [];
  let pageToken: string | undefined;
  do {
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q: `label:${label}`,
      maxResults: 500,
      pageToken,
    });
    messages.push(...(listRes.data.messages ?? []));
    pageToken = listRes.data.nextPageToken ?? undefined;
  } while (pageToken);

  const unimported = messages.filter((m) => m.id && !importedIds.has(m.id));
  const newMessages = unimported.slice(0, MAX_NEW_MESSAGES);
  const notScanned = unimported.length - newMessages.length;

  if (newMessages.length === 0) {
    return NextResponse.json({ attachments: [], skipped: [], notScanned: 0, account: stored.email });
  }

  const attachments: GmailAttachment[] = [];
  const skipped: Array<{ messageId: string; subject: string; from: string; date: string; reason: SkipReason }> = [];

  for (const msg of newMessages) {
    if (!msg.id) continue;

    const msgRes = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id,
      format: 'full',
    });

    const headers = msgRes.data.payload?.headers ?? [];
    const subject = headers.find((h) => h.name === 'Subject')?.value ?? '(no subject)';
    const from = headers.find((h) => h.name === 'From')?.value ?? '';
    const dateHeader = headers.find((h) => h.name === 'Date')?.value ?? '';

    // ── Layer 1: look for PDF attachments (original behaviour) ──────────────
    let foundAttachment = false;
    const parts = (msgRes.data.payload?.parts ?? []) as MessagePart[];

    for (const part of parts) {
      if (
        part.filename &&
        part.filename.toLowerCase().endsWith('.pdf') &&
        part.body?.attachmentId
      ) {
        const attRes = await gmail.users.messages.attachments.get({
          userId: 'me',
          messageId: msg.id,
          id: part.body.attachmentId,
        });

        attachments.push({
          messageId: msg.id,
          subject,
          from,
          date: dateHeader,
          attachmentId: part.body.attachmentId,
          attachmentName: part.filename,
          attachmentSize: part.body.size ?? 0,
          data: attRes.data.data ?? '',
          sourceType: 'email',
        });
        foundAttachment = true;
      }
    }

    if (foundAttachment) continue;

    // ── Layer 2: no attachment — scan body for PDF download links ────────────
    const bodyText = extractBodyText((msgRes.data.payload ?? {}) as MessagePart);
    const urls = extractPdfUrls(bodyText);

    const reasons: SkipReason[] = [];
    let gotPdf = false;
    for (const url of urls.slice(0, 5)) {
      const result = await tryFetchPdf(url);
      if ('reason' in result) { reasons.push(result.reason); continue; }
      const pdfBuf = result.pdf;
      gotPdf = true;

      // Derive a filename from the URL path component
      const rawName = url.split('/').pop()?.split('?')[0]?.split('#')[0] ?? '';
      const fileName = /\.pdf$/i.test(rawName) ? rawName : `invoice-${msg.id}.pdf`;

      // Encode as base64url to match the format that base64UrlToFile() on the client expects
      const data = pdfBuf
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

      attachments.push({
        messageId: msg.id,
        subject,
        from,
        date: dateHeader,
        attachmentId: '',
        attachmentName: fileName,
        attachmentSize: pdfBuf.length,
        data,
        sourceType: 'portal',
      });
      break; // one PDF per email
    }
    // No attachment and no link yielded a PDF — report it instead of dropping it silently
    if (!gotPdf) {
      const reason = REASON_PRIORITY.find((r) => reasons.includes(r)) ?? 'no_pdf';
      skipped.push({ messageId: msg.id, subject, from, date: dateHeader, reason });
    }
  }

  return NextResponse.json({ attachments, skipped, notScanned, account: stored.email });
}
