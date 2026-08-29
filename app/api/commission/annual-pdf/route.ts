import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import type { AnnualOverview } from '@/utils/commissionYear';
import { buildAnnualOverviewHTML } from '@/utils/annualStatementHtml';
import { generatePDF } from '@/utils/pdfGenerate';

// POST /api/commission/annual-pdf — render the annual commission overview to a
// downloadable landscape PDF.
//
// Takes the overview the client already built rather than recomputing it here:
// the table is assembled from three client-side fetches (bookings, variable
// costs, settlements), so recomputing server-side would risk exporting numbers
// the operator never saw. Same contract as /api/commission/pdf.
export async function POST(req: NextRequest) {
  const guard = await requireRole(['admin', 'super', 'accountant']);
  if ('error' in guard) return guard.error;

  const overview = (await req.json()) as AnnualOverview;
  if (!overview?.year || !Array.isArray(overview.rows) || !overview.total) {
    return NextResponse.json({ error: 'Invalid annual overview' }, { status: 400 });
  }

  try {
    const html = buildAnnualOverviewHTML(overview);
    const pdf = await generatePDF(html, { landscape: true });
    const filename = `Annual_Commission_Overview_${overview.year}.pdf`;
    return new NextResponse(pdf as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'PDF generation failed' },
      { status: 500 },
    );
  }
}
