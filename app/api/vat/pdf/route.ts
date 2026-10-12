import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { loadVatData, monthResult } from '@/utils/vat/loadInputs';
import { isValidMonth } from '@/utils/vat/czechCalendar';
import { buildVatPdfHtml } from '@/utils/vat/pdfHtml';
import { generatePDF } from '@/utils/pdfGenerate';

// GET /api/vat/pdf?month=YYYY-MM — the month's VAT summary as a PDF for the accountant.
// &view=html returns the same document as a printable web page (fallback if PDF rendering fails).
export async function GET(req: NextRequest) {
  const guard = await requireRole(['admin', 'accountant']);
  if ('error' in guard) return guard.error;

  const params = new URL(req.url).searchParams;
  const month = params.get('month');
  if (!isValidMonth(month)) return NextResponse.json({ error: 'month=YYYY-MM is required' }, { status: 400 });

  try {
    const data = await loadVatData();
    const result = monthResult(data, month);
    const html = await buildVatPdfHtml(result, data.settings.config);
    if (params.get('view') === 'html') {
      return new NextResponse(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    const pdf = await generatePDF(html);
    const tag = result.mode === 'simulation' ? '_SIMULACE' : '';
    return new NextResponse(pdf as unknown as BodyInit, {
      status: 200,
      headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="DPH_${month}${tag}.pdf"`, 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    console.error('[vat/pdf]', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'PDF generation failed' }, { status: 500 });
  }
}
