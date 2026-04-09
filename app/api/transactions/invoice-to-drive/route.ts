/**
 * POST /api/transactions/invoice-to-drive
 *
 * Generates a guest invoice PDF via Chromium and pushes it to the
 * "Baker House - Příjmy" Drive folder.  Also upserts the corresponding
 * RevenueInvoice in Redis so it shows up (unreconciled) in the
 * Accounting → Revenue tab.
 *
 * Body: { reservation: Reservation; includeQR?: boolean }
 * Returns: { driveUrl, driveFileId, driveFileName, invoice: RevenueInvoice }
 */
import { NextResponse } from 'next/server';
import { google } from 'googleapis';
import QRCodeLib from 'qrcode';
import { Redis } from '@upstash/redis';
import { auth } from '@/auth';
import { requireRole } from '@/utils/authGuard';
import { generatePDF } from '@/utils/pdfGenerate';
import {
  buildInvoiceHTML,
  generateInvoiceNumber,
  PAYMENT_IBAN,
} from '@/utils/invoiceUtils';
import type { Reservation } from '@/types/reservation';
import type { RevenueInvoice } from '@/types/revenueInvoice';

const REV_KEY          = 'baker:revenue-invoices';
const FOLDER_CACHE_KEY = 'baker:drive-revenue-folder-id';
const FOLDER_NAME      = 'Baker House - Příjmy';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

function safe(str: string): string {
  return str.replace(/[^a-zA-Z0-9\u00C0-\u024F._-]/g, '_').slice(0, 50);
}

function buildSPDString(iban: string, amountCZK: number, vs: string): string {
  return `SPD*1.0*ACC:${iban}*AM:${amountCZK.toFixed(2)}*CC:CZK*VS:${vs}*MSG:Baker House Apartments`;
}

async function getOrCreateFolder(drive: ReturnType<typeof google.drive>): Promise<string> {
  const cached = await redis.get<string>(FOLDER_CACHE_KEY);
  if (cached) return cached;

  const search = await drive.files.list({
    q: `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
    spaces: 'drive',
  });
  if (search.data.files?.length) {
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
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  const session = await auth();
  const s = session as unknown as Record<string, unknown>;
  const refreshToken = s?.refreshToken as string | undefined;
  if (!refreshToken) {
    return NextResponse.json({ error: 'No refresh token. Please sign out and sign in again.' }, { status: 401 });
  }

  const { reservation, includeQR }: { reservation: Reservation; includeQR?: boolean } = await request.json();

  if (!reservation.invoiceData) {
    return NextResponse.json({ error: 'No invoice data on reservation' }, { status: 400 });
  }

  const invoiceNum = generateInvoiceNumber(reservation.reservationNumber);
  const vs         = invoiceNum.replace(/\D/g, '');

  // Build QR payload if requested
  let payment: { qrDataUrl: string; info: { spdString: string; vs: string; amountCZK: number } } | undefined;
  if (includeQR) {
    const spdString = buildSPDString(PAYMENT_IBAN, reservation.price, vs);
    const qrDataUrl = await QRCodeLib.toDataURL(spdString, { width: 200, margin: 1, errorCorrectionLevel: 'M' });
    payment = { qrDataUrl, info: { spdString, vs, amountCZK: reservation.price } };
  }

  const html      = buildInvoiceHTML(reservation, reservation.invoiceData, invoiceNum, payment, true);
  const pdfBuffer = await generatePDF(html);

  // ── Upload to Drive ──────────────────────────────────────────────────────
  const oauth2 = new google.auth.OAuth2(process.env.AUTH_GOOGLE_ID, process.env.AUTH_GOOGLE_SECRET);
  oauth2.setCredentials({ refresh_token: refreshToken });
  const { token: freshToken } = await oauth2.getAccessToken();
  if (!freshToken) {
    return NextResponse.json({ error: 'Could not refresh Google token.' }, { status: 401 });
  }
  oauth2.setCredentials({ access_token: freshToken });

  const drive    = google.drive({ version: 'v3', auth: oauth2 });
  const folderId = await getOrCreateFolder(drive);

  const guestName  = `${reservation.firstName}_${reservation.lastName}`;
  const today      = new Date().toISOString().slice(0, 10);
  const fileName   = `${today}_${safe(guestName)}_${safe(invoiceNum)}_${Math.round(reservation.price)}CZK.pdf`;

  const { Readable } = await import('stream');
  const driveRes = await drive.files.create({
    requestBody: { name: fileName, parents: [folderId], mimeType: 'application/pdf' },
    media: { mimeType: 'application/pdf', body: Readable.from(pdfBuffer) },
    fields: 'id,name,webViewLink',
  });

  const driveFileId  = driveRes.data.id!;
  const driveFileName = driveRes.data.name!;
  const driveUrl     = driveRes.data.webViewLink!;

  // ── Upsert RevenueInvoice in Redis ───────────────────────────────────────
  const raw      = await redis.get(REV_KEY);
  const invoices = (Array.isArray(raw) ? raw : []) as RevenueInvoice[];
  const id       = `rev-${reservation.reservationNumber}`;
  const existing = invoices.findIndex((i) => i.id === id);
  const now      = new Date().toISOString();

  const invoice: RevenueInvoice = {
    id,
    sourceType:        'issued',
    category:          'accommodation_direct',
    status:            existing >= 0 ? invoices[existing].status : 'pending',
    invoiceNumber:     invoiceNum,
    invoiceDate:       today,
    amountCZK:         reservation.price,
    reservationNumber: reservation.reservationNumber,
    guestName:         `${reservation.firstName} ${reservation.lastName}`.trim(),
    bankTransactionId: existing >= 0 ? invoices[existing].bankTransactionId : undefined,
    reconciledAt:      existing >= 0 ? invoices[existing].reconciledAt : undefined,
    driveFileId,
    driveFileName,
    driveUrl,
    createdAt:         existing >= 0 ? invoices[existing].createdAt : now,
  };

  if (existing >= 0) {
    invoices[existing] = invoice;
  } else {
    invoices.push(invoice);
  }
  await redis.set(REV_KEY, invoices);

  return NextResponse.json({ driveUrl, driveFileId, driveFileName, invoice });
}
