import { NextResponse } from 'next/server';
import { google } from 'googleapis';
import { Redis } from '@upstash/redis';
import { requireRole } from '@/utils/authGuard';
import type { SupplierInvoice } from '@/types/supplierInvoice';
import type { GmailInvoiceToken } from '@/app/api/accounting/connect-gmail/callback/route';

const INVOICES_KEY = 'baker:supplier-invoices';
const TOKEN_KEY = 'baker:gmail-invoice-token';

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

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
}

export async function POST() {
  const guard = await requireRole(['admin']);
  if ('error' in guard) return guard.error;

  const label = process.env.GMAIL_INVOICE_LABEL;
  if (!label) return NextResponse.json({ error: 'GMAIL_INVOICE_LABEL not configured' }, { status: 503 });

  const redis = getRedis();
  if (!redis) return NextResponse.json({ error: 'Redis not configured' }, { status: 503 });

  // Load the stored OAuth token for the invoice Gmail account
  const stored = await redis.get(TOKEN_KEY) as GmailInvoiceToken | null;
  if (!stored?.refreshToken) {
    return NextResponse.json(
      { error: 'Invoice Gmail account not connected. Please connect it in the Accounting settings.' },
      { status: 401 }
    );
  }

  // Use the stored refresh token to get a fresh access token
  const clientId = process.env.AUTH_GOOGLE_ID;
  const clientSecret = process.env.AUTH_GOOGLE_SECRET;
  if (!clientId || !clientSecret) {
    return NextResponse.json({ error: 'Google OAuth credentials not configured' }, { status: 503 });
  }

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({ refresh_token: stored.refreshToken });

  // Refresh the access token
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
  const raw = await redis.get(INVOICES_KEY);
  const existing = (Array.isArray(raw) ? raw : []) as SupplierInvoice[];
  const importedIds = new Set(existing.map((inv) => inv.gmailMessageId).filter(Boolean));

  // Search for emails in the configured label with PDF attachments
  const query = `label:${label} has:attachment filename:*.pdf`;
  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: 50,
  });

  const messages = listRes.data.messages ?? [];
  const newMessages = messages.filter((m) => m.id && !importedIds.has(m.id));

  if (newMessages.length === 0) {
    return NextResponse.json({ attachments: [] });
  }

  const attachments: GmailAttachment[] = [];

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

    const parts = msgRes.data.payload?.parts ?? [];
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
        });
      }
    }
  }

  return NextResponse.json({ attachments });
}
