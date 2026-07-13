import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import type { CommissionSettlement } from '@/types/commissionSettlement';
import { buildSettlementHTML } from '@/utils/settlementHtml';
import { generatePDF } from '@/utils/pdfGenerate';

// POST /api/commission/pdf — render a settlement statement to a downloadable PDF.
// Accepts a full settlement snapshot (issued or freshly computed) so the
// operator can export before or after persisting to history.
export async function POST(req: NextRequest) {
  const guard = await requireRole(['admin', 'super', 'accountant']);
  if ('error' in guard) return guard.error;

  const settlement = (await req.json()) as CommissionSettlement;
  if (!settlement?.unitId || !settlement?.month) {
    return NextResponse.json({ error: 'Invalid settlement' }, { status: 400 });
  }

  try {
    const html = buildSettlementHTML(settlement);
    const pdf = await generatePDF(html);
    const filename = `Settlement_${settlement.unitId.replace(/\./g, '')}_${settlement.month}.pdf`;
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
