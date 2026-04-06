import { NextResponse } from 'next/server';
import { google } from 'googleapis';
import { auth } from '@/auth';
import { requireRole } from '@/utils/authGuard';

/** Sanitise a string for use in a Drive filename segment */
function safe(str: string): string {
  return str.replace(/[^a-zA-Z0-9\u00C0-\u024F\u0400-\u04FF._-]/g, '_').slice(0, 50);
}

export async function POST(request: Request) {
  const guard = await requireRole(['admin']);
  if ('error' in guard) return guard.error;

  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!folderId) return NextResponse.json({ error: 'GOOGLE_DRIVE_FOLDER_ID not configured' }, { status: 503 });

  // Use the admin's own Google OAuth tokens — no service account needed
  const session = await auth();
  const s = session as unknown as Record<string, unknown>;
  const accessToken = s?.accessToken as string | undefined;
  const refreshToken = s?.refreshToken as string | undefined;
if (!refreshToken && !accessToken) {
    return NextResponse.json(
      { error: 'No Google token. Please sign out and sign in again to grant Drive access.' },
      { status: 401 }
    );
  }

  const formData = await request.formData();
  const file = formData.get('file') as File | null;
  const supplierName = (formData.get('supplierName') as string | null) ?? 'Unknown';
  const invoiceNumber = (formData.get('invoiceNumber') as string | null) ?? 'no-inv';
  const amountCZK = (formData.get('amountCZK') as string | null) ?? '0';
  const invoiceDate = (formData.get('invoiceDate') as string | null) ?? new Date().toISOString().slice(0, 10);

  if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 });

  const bytes = await file.arrayBuffer();
  const buffer = Buffer.from(bytes);

  // Build filename: YYYY-MM-DD_SupplierName_InvNo_AmountCZK.pdf
  const fileName = `${invoiceDate}_${safe(supplierName)}_${safe(invoiceNumber)}_${amountCZK}CZK.pdf`;

  if (!refreshToken) {
    return NextResponse.json(
      { error: 'No refresh token in session. Please sign out and sign in again.' },
      { status: 401 }
    );
  }

  const oauth2 = new google.auth.OAuth2(
    process.env.AUTH_GOOGLE_ID,
    process.env.AUTH_GOOGLE_SECRET,
  );
  // Set only the refresh token — forces getAccessToken() to always fetch a fresh access token
  oauth2.setCredentials({ refresh_token: refreshToken });

  const { token: freshToken } = await oauth2.getAccessToken();
  if (!freshToken) {
    return NextResponse.json(
      { error: 'Could not refresh Google token. Please sign out and sign in again.' },
      { status: 401 }
    );
  }
  oauth2.setCredentials({ access_token: freshToken });

  const drive = google.drive({ version: 'v3', auth: oauth2 });

  const { Readable } = await import('stream');
  const readable = Readable.from(buffer);

  const res = await drive.files.create({
    supportsAllDrives: true,
    requestBody: {
      name: fileName,
      parents: [folderId],
      mimeType: 'application/pdf',
    },
    media: {
      mimeType: 'application/pdf',
      body: readable,
    },
    fields: 'id,name,webViewLink',
  });

  const { id, name, webViewLink } = res.data;

  return NextResponse.json({ fileId: id, fileName: name, driveUrl: webViewLink });
}
