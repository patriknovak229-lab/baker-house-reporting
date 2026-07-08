/**
 * POST /api/revenue-invoices/extract-settlement
 *
 * Extracts structured data from an OTA monthly earnings/settlement report
 * (e.g. an Airbnb "Earnings report"). Unlike a guest invoice, this document
 * carries gross earnings, the OTA commission, and the net payout, plus the
 * period it COVERS — which drives accrual recognition in the P&L.
 *
 * Returns ExtractedSettlementData — the caller reviews and creates a
 * SettlementGroup from it.
 */
import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import sharp from 'sharp';
import { requireRole } from '@/utils/authGuard';
import { REVENUE_KNOWLEDGE } from '@/utils/revenueKnowledge';
import type { SettlementSource } from '@/types/settlementGroup';

export interface ExtractedSettlementData {
  source:            SettlementSource | null;
  periodStart:       string | null;  // YYYY-MM-DD — the period the report covers
  periodEnd:         string | null;
  grossAmount:       number | null;  // gross earnings (booking volume) before fees
  adjustmentsAmount: number | null;
  commissionAmount:  number | null;  // OTA service fee / commission (positive magnitude)
  taxWithheld:       number | null;
  netAmount:         number | null;  // net payout (= gross − commission ± adjustments/tax)
  currency:          string | null;
}

const EXTRACTION_PROMPT = `Extract structured data from this OTA monthly earnings / settlement report (e.g. Airbnb, Booking.com).
Return ONLY valid JSON, no markdown, no extra text:
{
  "source": "airbnb"|"booking"|"other" or null,
  "periodStart": "YYYY-MM-DD" or null,
  "periodEnd": "YYYY-MM-DD" or null,
  "grossAmount": number or null,
  "adjustmentsAmount": number or null,
  "commissionAmount": number or null,
  "taxWithheld": number or null,
  "netAmount": number or null,
  "currency": "CZK"|"EUR"|"USD"|"GBP" or null
}
source: which platform issued the report.
periodStart / periodEnd: the reporting period the document COVERS (accrual basis) — NOT the date it was generated/printed.
grossAmount: gross earnings / booking volume before the platform's fee.
commissionAmount: the platform's service fee / commission, as a POSITIVE number (drop any minus sign).
netAmount: the net payout amount that reaches the bank.
Read the printed numbers exactly; do not recompute totals. Strip currency symbols and thousands separators.
If a field cannot be determined, use null.`;

const FULL_PROMPT = `${EXTRACTION_PROMPT}

OTA-SPECIFIC GUIDANCE
Match the report to one of the sources below and apply its notes in addition to the rules above. If it is not listed, extract generically.
${REVENUE_KNOWLEDGE}`;

const CLAUDE_MAX_BYTES = 4.5 * 1024 * 1024;

function isHeic(mimeType: string, fileName: string): boolean {
  if (mimeType.startsWith('image/heic') || mimeType.startsWith('image/heif')) return true;
  const ext = fileName.split('.').pop()?.toLowerCase();
  return ext === 'heic' || ext === 'heif';
}

export async function POST(request: Request) {
  const guard = await requireRole(['admin', 'accountant']);
  if ('error' in guard) return guard.error;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 503 });

  const formData = await request.formData();
  const file = formData.get('file') as File | null;
  if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 });

  const bytes = await file.arrayBuffer();
  let buffer: Buffer = Buffer.from(bytes);
  let mediaType = file.type || 'application/octet-stream';

  if (isHeic(mediaType, file.name)) {
    try {
      buffer = await sharp(buffer).jpeg({ quality: 85 }).toBuffer();
      mediaType = 'image/jpeg';
    } catch {
      return NextResponse.json({ error: 'Could not convert HEIC image.' }, { status: 415 });
    }
  }

  if (mediaType.startsWith('image/') && buffer.length > CLAUDE_MAX_BYTES) {
    try {
      for (const quality of [75, 60, 45]) {
        const candidate = await sharp(buffer).jpeg({ quality }).toBuffer();
        if (candidate.length <= CLAUDE_MAX_BYTES) { buffer = candidate; mediaType = 'image/jpeg'; break; }
      }
    } catch { /* leave as-is */ }
  }

  const base64 = buffer.toString('base64');
  const client = new Anthropic({ apiKey });
  let content: Anthropic.MessageParam['content'];

  if (mediaType === 'application/pdf') {
    content = [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
      { type: 'text', text: FULL_PROMPT },
    ];
  } else if (mediaType.startsWith('image/')) {
    const SUPPORTED = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    const imgType = SUPPORTED.includes(mediaType)
      ? (mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp')
      : 'image/jpeg';
    content = [
      { type: 'image', source: { type: 'base64', media_type: imgType, data: base64 } },
      { type: 'text', text: FULL_PROMPT },
    ];
  } else {
    return NextResponse.json({ error: 'Unsupported file type. Upload a PDF or image.' }, { status: 400 });
  }

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [{ role: 'user', content }],
  });

  const rawText = message.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { type: 'text'; text: string }).text)
    .join('');

  let parsed: Record<string, unknown>;
  try {
    const jsonText = rawText.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim();
    parsed = JSON.parse(jsonText) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Failed to parse extraction response', raw: rawText }, { status: 502 });
  }

  const num = (v: unknown): number | null => (typeof v === 'number' && !Number.isNaN(v) ? v : null);
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
  const rawSource = str(parsed.source)?.toLowerCase();
  const source: SettlementSource | null =
    rawSource === 'airbnb' || rawSource === 'booking' ? rawSource : rawSource ? 'other' : null;

  const result: ExtractedSettlementData = {
    source,
    periodStart:       str(parsed.periodStart),
    periodEnd:         str(parsed.periodEnd),
    grossAmount:       num(parsed.grossAmount),
    adjustmentsAmount: num(parsed.adjustmentsAmount),
    // commission is always a positive magnitude
    commissionAmount:  num(parsed.commissionAmount) != null ? Math.abs(num(parsed.commissionAmount)!) : null,
    taxWithheld:       num(parsed.taxWithheld),
    netAmount:         num(parsed.netAmount),
    currency:          str(parsed.currency),
  };

  return NextResponse.json(result);
}
