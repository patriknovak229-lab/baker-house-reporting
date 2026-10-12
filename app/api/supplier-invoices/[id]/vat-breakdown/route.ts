import { NextResponse } from 'next/server';
import { google } from 'googleapis';
import { auth } from '@/auth';
import { requireRole } from '@/utils/authGuard';
import { readAllSupplierInvoices, writeAllSupplierInvoices } from '@/utils/supplierInvoicesStore';
import { readAllInvoiceCategories } from '@/utils/invoiceCategoriesStore';
import { deriveVatBreakdown, meaningfulVatRows, round2 } from '@/utils/invoiceChecks';
import { extractInvoice } from '@/utils/invoiceExtraction';
import type { ExtractedVatRow } from '@/types/supplierInvoice';

// One extraction (~3–8 s) plus the Drive download
export const maxDuration = 60;

type Outcome =
  | { status: 'already' | 'no_vat' }
  | { status: 'derived' | 'reread'; vatBreakdown: ExtractedVatRow[] }
  | { status: 'manual'; reason: string };

/**
 * Fill in the per-rate VAT split of one saved invoice (back-fill for the VAT report).
 *   1. Whole VAT at one rate → derived from the totals, no document needed.
 *   2. Mixed 12 %/21 % → re-read the archived PDF on Drive; the rows are only
 *      accepted when the re-read total AND VAT equal the saved ones (±1 Kč), so a
 *      misread can never overwrite a reviewed invoice. Nothing else is changed.
 *   3. Otherwise → 'manual' (fill "VAT by rate" in the invoice drawer).
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireRole(['admin']);
  if ('error' in guard) return guard.error;
  const { id } = await params;

  const invoices = await readAllSupplierInvoices();
  const inv = invoices.find((i) => i.id === id);
  if (!inv) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const save = async (rows: ExtractedVatRow[], status: 'derived' | 'reread'): Promise<Outcome> => {
    const fresh = await readAllSupplierInvoices();
    await writeAllSupplierInvoices(fresh.map((i) => (i.id === id ? { ...i, vatBreakdown: rows } : i)));
    return { status, vatBreakdown: rows };
  };

  let outcome: Outcome;
  if (inv.vatBreakdown && inv.vatBreakdown.length > 0) {
    outcome = { status: 'already' };
  } else if (!inv.vatAmountCZK) {
    outcome = { status: 'no_vat' };
  } else {
    const derived = deriveVatBreakdown(inv.amountCZK, inv.vatAmountCZK);
    if (derived) {
      outcome = await save(derived, 'derived');
    } else if (!inv.driveFileId) {
      outcome = { status: 'manual', reason: 'Mixed 12 %/21 % and no PDF on Drive to re-read' };
    } else {
      outcome = await rereadFromDrive(inv.driveFileId, inv.driveFileName ?? `${id}.pdf`, inv.amountCZK, inv.vatAmountCZK, save);
    }
  }
  return NextResponse.json(outcome);
}

async function rereadFromDrive(
  driveFileId: string,
  fileName: string,
  amount: number,
  vat: number,
  save: (rows: ExtractedVatRow[], status: 'reread') => Promise<Outcome>,
): Promise<Outcome> {
  const session = await auth();
  const refreshToken = (session as unknown as Record<string, unknown>)?.refreshToken as string | undefined;
  if (!refreshToken) return { status: 'manual', reason: 'No Google sign-in — sign out and back in' };

  let data: Buffer;
  try {
    const oauth2 = new google.auth.OAuth2(process.env.AUTH_GOOGLE_ID, process.env.AUTH_GOOGLE_SECRET);
    oauth2.setCredentials({ refresh_token: refreshToken });
    const drive = google.drive({ version: 'v3', auth: oauth2 });
    const dl = await drive.files.get(
      { fileId: driveFileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' },
    );
    data = Buffer.from(dl.data as ArrayBuffer);
  } catch {
    return { status: 'manual', reason: 'Could not download the PDF from Drive' };
  }

  try {
    const categories = await readAllInvoiceCategories();
    const ex = await extractInvoice({ data, mediaType: 'application/pdf', fileName, categories });
    const rows = meaningfulVatRows(ex.vatBreakdown);
    const sameTotals = ex.amountCZK != null && ex.vatAmountCZK != null &&
      Math.abs(Math.abs(ex.amountCZK) - Math.abs(amount)) <= 1 &&
      Math.abs(Math.abs(ex.vatAmountCZK) - Math.abs(vat)) <= 1;
    const rowVat = rows.reduce((s, r) => s + Math.abs(r.vat ?? 0), 0);
    if (rows.length === 0 || !sameTotals || Math.abs(rowVat - Math.abs(vat)) > 1) {
      return { status: 'manual', reason: 'Re-read PDF does not match the saved total/VAT' };
    }
    const sign = amount < 0 ? -1 : 1;
    return await save(rows.map((r) => ({
      rate: r.rate,
      base: r.base == null ? null : round2(sign * Math.abs(r.base)),
      vat: r.vat == null ? null : round2(sign * Math.abs(r.vat)),
    })), 'reread');
  } catch {
    return { status: 'manual', reason: 'Re-reading the PDF failed' };
  }
}
