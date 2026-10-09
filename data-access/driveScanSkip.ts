/**
 * Drive files the supplier-invoice Drive scan must never offer again — PDFs of
 * invoices removed from the ledger on purpose (e.g. paid with a private card).
 * The scan only skips files an existing invoice still points at, and both the
 * original and the archive copy live in the scanned folder, so a removed
 * invoice would otherwise come straight back on the next scan.
 *
 * One app_settings row; value = DriveScanSkipEntry[]. To let a file import
 * again, remove its entry from the row.
 */
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { appSettings } from '@/lib/db/schema';

const SETTING = 'drive-scan-skip-file-ids';

export interface DriveScanSkipEntry {
  fileId: string;
  /** Why it is skipped, e.g. "Alza 4025174099 — paid by private card" */
  note?: string;
  addedAt: string;
}

export async function readDriveScanSkipList(): Promise<DriveScanSkipEntry[]> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, SETTING)).limit(1);
  return (row?.value as DriveScanSkipEntry[] | undefined) ?? [];
}

export async function addDriveScanSkipEntries(entries: Array<{ fileId: string; note?: string }>): Promise<void> {
  const current = await readDriveScanSkipList();
  const known = new Set(current.map((e) => e.fileId));
  const addedAt = new Date().toISOString();
  const next = [
    ...current,
    ...entries.filter((e) => e.fileId && !known.has(e.fileId)).map((e) => ({ ...e, addedAt })),
  ];
  await db
    .insert(appSettings)
    .values({ key: SETTING, value: next, updatedAt: new Date() })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: next, updatedAt: new Date() } });
}
