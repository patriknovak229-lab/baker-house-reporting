import type { drive_v3 } from 'googleapis';
import type { Redis } from '@upstash/redis';

const FOLDER_CACHE_KEY = 'baker:drive-invoices-folder-id';
const FOLDER_NAME = 'Baker House - Faktury';

/** Sanitise a string for use in a Drive filename segment */
function safe(str: string): string {
  return str.replace(/[^a-zA-Z0-9À-ɏЀ-ӿ._-]/g, '_').slice(0, 50);
}

/** Get or create the shared invoices folder, caching the ID in Redis */
export async function getOrCreateInvoiceFolder(drive: drive_v3.Drive, redis: Redis): Promise<string> {
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

export interface InvoiceDriveMeta {
  supplierName: string;
  invoiceNumber: string;
  amountCZK: number;
  invoiceDate: string;
}

/**
 * Upload an invoice PDF buffer to the shared Drive folder, using the same
 * filename convention as the interactive upload route
 * (YYYY-MM-DD_Supplier_InvNo_AmountCZK.pdf).
 */
export async function uploadInvoicePdfToDrive(
  drive: drive_v3.Drive,
  redis: Redis,
  pdfBuffer: Buffer,
  meta: InvoiceDriveMeta,
): Promise<{ fileId: string; fileName: string; driveUrl: string }> {
  const folderId = await getOrCreateInvoiceFolder(drive, redis);
  const fileName = `${meta.invoiceDate}_${safe(meta.supplierName)}_${safe(meta.invoiceNumber)}_${Math.round(meta.amountCZK)}CZK.pdf`;

  const { Readable } = await import('stream');
  const readable = Readable.from(pdfBuffer);

  const res = await drive.files.create({
    requestBody: { name: fileName, parents: [folderId], mimeType: 'application/pdf' },
    media: { mimeType: 'application/pdf', body: readable },
    fields: 'id,name,webViewLink',
  });

  return {
    fileId: res.data.id ?? '',
    fileName: res.data.name ?? fileName,
    driveUrl: res.data.webViewLink ?? '',
  };
}
