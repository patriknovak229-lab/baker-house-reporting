import { NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { addDriveScanSkipEntries } from '@/data-access/driveScanSkip';

/**
 * POST { fileId, note? } — never offer this Drive file in the invoice Drive scan
 * again (e.g. a Booking.com commission invoice, which is booked from the
 * settlement report instead).
 */
export async function POST(request: Request) {
  const guard = await requireRole(['admin']);
  if ('error' in guard) return guard.error;

  const body = await request.json() as { fileId?: string; note?: string };
  if (!body.fileId?.trim()) return NextResponse.json({ error: 'fileId is required' }, { status: 400 });

  await addDriveScanSkipEntries([{ fileId: body.fileId.trim(), note: body.note?.slice(0, 200) }]);
  return NextResponse.json({ ok: true });
}
