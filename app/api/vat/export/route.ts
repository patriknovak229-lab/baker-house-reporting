import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { loadVatData, monthResult, pragueToday } from '@/utils/vat/loadInputs';
import { isValidMonth } from '@/utils/vat/czechCalendar';
import { buildDpXml, buildKhXml } from '@/utils/vat/khXml';
import { buildLedgerCsv, buildWorkbook } from '@/utils/vat/exports';

const FORMATS = ['kh-xml', 'dp-xml', 'csv', 'xlsx'] as const;
type Format = (typeof FORMATS)[number];

// GET /api/vat/export?month=YYYY-MM&format=kh-xml|dp-xml|csv|xlsx — downloads for EPO and the accountant.
export async function GET(req: NextRequest) {
  const guard = await requireRole(['admin', 'accountant']);
  if ('error' in guard) return guard.error;

  const params = new URL(req.url).searchParams;
  const month = params.get('month');
  const format = params.get('format') as Format | null;
  if (!isValidMonth(month)) return NextResponse.json({ error: 'month=YYYY-MM is required' }, { status: 400 });
  if (!format || !FORMATS.includes(format)) {
    return NextResponse.json({ error: `format must be one of ${FORMATS.join(', ')}` }, { status: 400 });
  }

  try {
    const data = await loadVatData();
    const result = monthResult(data, month);
    const cfg = data.settings.config;
    const tag = result.mode === 'simulation' ? '_SIMULACE' : '';
    let body: string | Buffer;
    let type: string;
    let filename: string;
    switch (format) {
      case 'kh-xml':
        body = buildKhXml(result, cfg, { preparedOn: pragueToday() });
        type = 'application/xml; charset=utf-8';
        filename = `DPHKH1_${cfg.dic}_${month}${tag}.xml`;
        break;
      case 'dp-xml':
        body = buildDpXml(result, cfg, { preparedOn: pragueToday() });
        type = 'application/xml; charset=utf-8';
        filename = `DPHDP3_${cfg.dic}_${month}${tag}.xml`;
        break;
      case 'csv':
        body = buildLedgerCsv(result);
        type = 'text/csv; charset=utf-8';
        filename = `DPH_${month}_doklady${tag}.csv`;
        break;
      case 'xlsx':
        body = await buildWorkbook(result, cfg);
        type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        filename = `DPH_${month}${tag}.xlsx`;
        break;
    }
    return new NextResponse(body as unknown as BodyInit, {
      status: 200,
      headers: { 'Content-Type': type, 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    console.error('[vat/export]', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Export failed' }, { status: 500 });
  }
}
