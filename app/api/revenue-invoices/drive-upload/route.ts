import { NextResponse } from 'next/server';
import { google } from 'googleapis';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { auth } from '@/auth';
import { requireRole } from '@/utils/authGuard';
import { Redis } from '@upstash/redis';
import type { RevenueInvoice } from '@/types/revenueInvoice';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const REV_KEY          = 'baker:revenue-invoices';
const FOLDER_CACHE_KEY = 'baker:drive-revenue-folder-id';
const FOLDER_NAME      = 'Baker House - Příjmy';

function safe(str: string): string {
  return str.replace(/[^a-zA-Z0-9\u00C0-\u024F\u0400-\u04FF._-]/g, '_').slice(0, 50);
}

async function getOrCreateFolder(drive: ReturnType<typeof google.drive>): Promise<string> {
  const cached = await redis.get<string>(FOLDER_CACHE_KEY);
  if (cached) return cached;

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

  const folder = await drive.files.create({
    requestBody: { name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' },
    fields: 'id',
  });
  const id = folder.data.id!;
  await redis.set(FOLDER_CACHE_KEY, id);
  return id;
}

export async function POST(request: Request) {
  const guard = await requireRole(['admin', 'accountant']);
  if ('error' in guard) return guard.error;

  const session = await auth();
  const s = session as unknown as Record<string, unknown>;
  const refreshToken = s?.refreshToken as string | undefined;
  if (!refreshToken) {
    return NextResponse.json({ error: 'No refresh token. Please sign out and sign in again.' }, { status: 401 });
  }

  const formData  = await request.formData();
  const file        = formData.get('file') as File | null;
  const invoiceId   = formData.get('invoiceId') as string | null;
  const clientName  = (formData.get('clientName')  as string | null) ?? 'Unknown';
  const invoiceNumber = (formData.get('invoiceNumber') as string | null) ?? 'no-inv';
  const amountCZK   = (formData.get('amountCZK')   as string | null) ?? '0';
  const invoiceDate = (formData.get('invoiceDate')  as string | null) ?? new Date().toISOString().slice(0, 10);

  if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 });

  const bytes = await file.arrayBuffer();
  let buffer = Buffer.from(bytes);

  // Convert images → PDF (same logic as costs route)
  if (file.type.startsWith('image/') || /\.(heic|heif)$/i.test(file.name)) {
    try {
      let imageBuffer: Buffer;
      let isPng = false;
      if (file.type === 'image/png') {
        imageBuffer = await sharp(buffer).png().toBuffer();
        isPng = true;
      } else {
        imageBuffer = await sharp(buffer).jpeg({ quality: 90 }).toBuffer();
      }
      const pdfDoc = await PDFDocument.create();
      const embeddedImage = isPng ? await pdfDoc.embedPng(imageBuffer) : await pdfDoc.embedJpg(imageBuffer);
      const { width, height } = embeddedImage;
      const page = pdfDoc.addPage([width, height]);
      page.drawImage(embeddedImage, { x: 0, y: 0, width, height });
      buffer = Buffer.from(await pdfDoc.save());
    } catch (err) {
      console.error('Image→PDF conversion failed:', err);
      return NextResponse.json({ error: 'Could not convert image to PDF.' }, { status: 422 });
    }
  }

  const fileName = `${invoiceDate}_${safe(clientName)}_${safe(invoiceNumber)}_${amountCZK}CZK.pdf`;

  const oauth2 = new google.auth.OAuth2(process.env.AUTH_GOOGLE_ID, process.env.AUTH_GOOGLE_SECRET);
  oauth2.setCredentials({ refresh_token: refreshToken });
  const { token: freshToken } = await oauth2.getAccessToken();
  if (!freshToken) {
    return NextResponse.json({ error: 'Could not refresh Google token.' }, { status: 401 });
  }
  oauth2.setCredentials({ access_token: freshToken });

  const drive    = google.drive({ version: 'v3', auth: oauth2 });
  const folderId = await getOrCreateFolder(drive);

  const { Readable } = await import('stream');
  const res = await drive.files.create({
    requestBody: { name: fileName, parents: [folderId], mimeType: 'application/pdf' },
    media: { mimeType: 'application/pdf', body: Readable.from(buffer) },
    fields: 'id,name,webViewLink',
  });

  const { id, name, webViewLink } = res.data;

  // If invoiceId provided, persist drive fields back to Redis
  if (invoiceId) {
    const raw = await redis.get(REV_KEY);
    const invoices = (Array.isArray(raw) ? raw : []) as RevenueInvoice[];
    const idx = invoices.findIndex((i) => i.id === invoiceId);
    if (idx >= 0) {
      invoices[idx] = { ...invoices[idx], driveFileId: id!, driveFileName: name!, driveUrl: webViewLink! };
      await redis.set(REV_KEY, invoices);
      return NextResponse.json({ fileId: id, fileName: name, driveUrl: webViewLink, invoice: invoices[idx] });
    }
  }

  return NextResponse.json({ fileId: id, fileName: name, driveUrl: webViewLink });
}
