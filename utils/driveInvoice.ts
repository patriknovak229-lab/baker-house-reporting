import type { drive_v3 } from 'googleapis';
import type { Redis } from '@upstash/redis';

const FOLDER_CACHE_KEY = 'baker:drive-invoices-folder-id';
const FOLDER_NAME = 'Baker House - Faktury';

/** Sanitise a string for use in a Drive filename segment */
function safe(str: string): string {
  return str.replace(/[^a-zA-Z0-9À-ɏЀ-ӿ._-]/g, '_').slice(0, 50);
}

/** Canonical invoice PDF filename (YYYY-MM-DD_Supplier_InvNo_AmountCZK.pdf). */
export function invoiceFileName(invoiceDate: string, name: string, invoiceNumber: string, amountCZK: number): string {
  return `${invoiceDate}_${safe(name)}_${safe(invoiceNumber)}_${Math.round(amountCZK)}CZK.pdf`;
}

/** Extract a Drive file id from a webViewLink (…/file/d/<id>/… or …?id=<id>). */
export function parseDriveFileId(url?: string): string | null {
  if (!url) return null;
  const m = url.match(/\/d\/([a-zA-Z0-9_-]+)/) ?? url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
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
  const fileName = invoiceFileName(meta.invoiceDate, meta.supplierName, meta.invoiceNumber, meta.amountCZK);

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

/** Find or create a named subfolder under a parent folder. Returns its id + link. */
export async function getOrCreateSubfolder(
  drive: drive_v3.Drive,
  parentId: string,
  name: string,
): Promise<{ id: string; webViewLink: string }> {
  const escaped = name.replace(/'/g, "\\'");
  const search = await drive.files.list({
    q: `name='${escaped}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`,
    fields: 'files(id,webViewLink)',
    spaces: 'drive',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  const found = search.data.files?.[0];
  if (found?.id) {
    return { id: found.id, webViewLink: found.webViewLink ?? `https://drive.google.com/drive/folders/${found.id}` };
  }

  const folder = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    fields: 'id,webViewLink',
    supportsAllDrives: true,
  });
  const id = folder.data.id!;
  return { id, webViewLink: folder.data.webViewLink ?? `https://drive.google.com/drive/folders/${id}` };
}

/** Set of existing (non-trashed) file names directly inside a folder. */
export async function listFolderFileNames(drive: drive_v3.Drive, folderId: string): Promise<Set<string>> {
  const names = new Set<string>();
  let pageToken: string | undefined;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'nextPageToken, files(name)',
      spaces: 'drive',
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const f of res.data.files ?? []) if (f.name) names.add(f.name);
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return names;
}

/** Copy an existing Drive file into a folder under a given name. Returns the new file id. */
export async function copyFileToFolder(
  drive: drive_v3.Drive,
  sourceFileId: string,
  name: string,
  parentId: string,
): Promise<string> {
  const res = await drive.files.copy({
    fileId: sourceFileId,
    requestBody: { name, parents: [parentId] },
    fields: 'id',
    supportsAllDrives: true,
  });
  return res.data.id ?? '';
}
