import { NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { readGmailInvoiceToken, deleteGmailInvoiceToken } from '@/utils/gmailInvoiceTokenStore';

/** GET /api/accounting/connect-gmail/status
 *  Returns whether the invoice Gmail account is connected. */
export async function GET() {
  const guard = await requireRole(['admin', 'accountant']);
  if ('error' in guard) return guard.error;

  const token = await readGmailInvoiceToken();
  if (!token?.refreshToken) return NextResponse.json({ connected: false });

  return NextResponse.json({
    connected: true,
    email: token.email,
    connectedAt: token.connectedAt,
  });
}

/** DELETE /api/accounting/connect-gmail/status
 *  Disconnects the invoice Gmail account by removing the stored token. */
export async function DELETE() {
  const guard = await requireRole(['admin']);
  if ('error' in guard) return guard.error;

  await deleteGmailInvoiceToken();
  return NextResponse.json({ ok: true });
}
