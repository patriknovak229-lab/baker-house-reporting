/**
 * GET /api/corporate/invoices/document?id=CI-…&format=pdf|html
 *
 *   issued / sent / paid / void → the frozen document (PDF download, or HTML)
 *   scheduled                   → HTML only: a watermarked preview of what it
 *                                 would bill if issued today
 *
 * HTML exists because PDFs can't be rendered on a dev Mac (see
 * docs/corporate.md §7) and it's the quickest check before sending.
 *
 * In CHROMIUM_ROUTES (next.config.ts). Auth: corporate view.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAccess } from '@/utils/authGuard';
import { getInvoice } from '@/data-access/corporateInvoices';
import { InvoiceError } from '@/utils/corporateInvoiceService';
import {
  invoiceFilename,
  renderDraftInvoiceHtml,
  renderInvoicePdf,
  renderIssuedInvoiceHtml,
} from '@/utils/corporateInvoiceSend';
import { pragueToday } from '@/utils/periodUtils';

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const guard = await requireAccess('corporate', 'view');
  if ('error' in guard) return guard.error;
  const id = req.nextUrl.searchParams.get('id');
  const format = req.nextUrl.searchParams.get('format') === 'html' ? 'html' : 'pdf';
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });
  const inv = await getInvoice(id);
  if (!inv) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });

  try {
    if (!inv.invoiceNumber) {
      const html = await renderDraftInvoiceHtml(inv, pragueToday());
      return new NextResponse(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    if (format === 'html') {
      return new NextResponse(await renderIssuedInvoiceHtml(inv), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    const pdf = await renderInvoicePdf(inv);
    return new NextResponse(pdf as unknown as BodyInit, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${invoiceFilename(inv)}"`,
      },
    });
  } catch (err) {
    const status = err instanceof InvoiceError ? err.status : 500;
    console.error('[corporate-invoice] document failed:', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Rendering failed' }, { status });
  }
}
