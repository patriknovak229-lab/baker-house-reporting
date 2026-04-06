import { NextResponse } from 'next/server';
import { google } from 'googleapis';
import { auth } from '@/auth';
import { requireRole } from '@/utils/authGuard';
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const FOLDER_CACHE_KEY = 'baker:drive-invoices-folder-id';
const FOLDER_NAME = 'Baker House - Faktury';

/** Sanitise a string for use in a Drive filename segment */
function safe(str: string): string {
  return str.replace(/[^a-zA-Z0-9\u00C0-\u024F\u0400-\u04FF._-]/g, '_').slice(0, 50);
}

/** Get or create the invoices folder, caching the ID in Redis */
async function getOrCreateFolder(drive: ReturnType<typeof google.drive>): Promise<string> {
  // Check Redis cache first
  const cached = await redis.get<string>(FOLDER_CACHE_KEY);
  if (cached) return cached;

  // Try to find existing folder by name
  const search = await drive.files.list({
    q: `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id,name)',
    spaces: 'drive',
  });

  if (search.data.files && search.data.files.length > 0) {
    const id = search.data.files[0].id!;
    await redis.set(FOLDER_CACHE_KEY, id);
    return id;
  }

  // Create the folder
  const folder = await drive.files.create({
    requestBody: {
      name: FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
    },
    fields: 'id',
  });

  const id = folder.data.id!;
  await redis.set(FOLDER_CACHE_KEY, id);
  return id;
}

export async function POST(request: Request) {
  const guard = await requireRole(['admin']);
  if ('error' in guard) return guard.error;

  // Use the admin's own Google OAuth tokens
  const session = await auth();
  const s = session as unknown as Record<string, unknown>;
  const refreshToken = s?.refreshToken as string | undefined;

  if (!refreshToken) {
    return NextResponse.json(
      { error: 'No refresh token in session. Please sign out and sign in again.' },
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

  const oauth2 = new google.auth.OAuth2(
    process.env.AUTH_GOOGLE_ID,
    process.env.AUTH_GOOGLE_SECRET,
  );
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

  // Get or auto-create the invoices folder
  const folderId = await getOrCreateFolder(drive);

  const { Readable } = await import('stream');
  const readable = Readable.from(buffer);

  const res = await drive.files.create({
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
