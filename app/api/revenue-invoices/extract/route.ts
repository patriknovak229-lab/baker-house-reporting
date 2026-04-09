/**
 * POST /api/revenue-invoices/extract
 *
 * Extracts structured data from an externally-issued revenue invoice PDF.
 * The invoice was issued BY Baker House TO a client (opposite of supplier invoices).
 * Returns ExtractedRevenueData — caller auto-fills missing fields.
 */
import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import sharp from 'sharp';
import { requireRole } from '@/utils/authGuard';

export interface ExtractedRevenueData {
  clientName:    string | null;
  invoiceNumber: string | null;  // null → caller generates "INV-{client}-{MM}-{DD}"
  invoiceDate:   string | null;  // YYYY-MM-DD
  dueDate:       string | null;  // YYYY-MM-DD; null → use invoiceDate
  amountCZK:     number | null;
  currency:      string | null;
  description:   string | null;
}

const EXTRACTION_PROMPT = `Extract structured data from this invoice. The invoice was issued by Baker House Apartments to a client/payer.
Return ONLY valid JSON, no markdown, no extra text:
{
  "clientName": string or null,
  "invoiceNumber": string or null,
  "invoiceDate": "YYYY-MM-DD" or null,
  "dueDate": "YYYY-MM-DD" or null,
  "totalAmount": number or null,
  "currency": "CZK"|"EUR"|"USD"|"GBP" or null,
  "description": string or null
}
clientName: the name of the payer/client/customer (not Baker House).
invoiceNumber: the invoice or document number as printed.
totalAmount: total amount payable (with VAT if present). Extract the number only, no currency symbol.
description: one brief sentence describing the service or product invoiced, or null.
If a field cannot be determined, use null.`;

const CLAUDE_MAX_BYTES = 4.5 * 1024 * 1024;

function isHeic(mimeType: string, fileName: string): boolean {
  if (mimeType === 'image/heic' || mimeType === 'image/heif') return true;
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
      { type: 'text', text: EXTRACTION_PROMPT },
    ];
  } else if (mediaType.startsWith('image/')) {
    const SUPPORTED = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    const imgType = SUPPORTED.includes(mediaType)
      ? (mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp')
      : 'image/jpeg';
    content = [
      { type: 'image', source: { type: 'base64', media_type: imgType, data: base64 } },
      { type: 'text', text: EXTRACTION_PROMPT },
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

  const invoiceDate = typeof parsed.invoiceDate === 'string' ? parsed.invoiceDate : null;
  const rawDueDate  = typeof parsed.dueDate      === 'string' ? parsed.dueDate      : null;
  const clientName  = typeof parsed.clientName   === 'string' ? parsed.clientName   : null;

  // Auto-generate invoice number if missing
  let invoiceNumber = typeof parsed.invoiceNumber === 'string' ? parsed.invoiceNumber : null;
  if (!invoiceNumber) {
    const dateForFallback = invoiceDate ?? new Date().toISOString().slice(0, 10);
    const [, mm, dd] = dateForFallback.split('-');
    const namePart = clientName ? clientName.replace(/\s+/g, '-').slice(0, 20) : 'unknown';
    invoiceNumber = `INV-${namePart}-${mm}-${dd}`;
  }

  const result: ExtractedRevenueData = {
    clientName,
    invoiceNumber,
    invoiceDate,
    dueDate:    rawDueDate ?? invoiceDate, // fall back to issue date
    amountCZK:  typeof parsed.totalAmount === 'number' ? parsed.totalAmount : null,
    currency:   typeof parsed.currency    === 'string' ? parsed.currency    : null,
    description: typeof parsed.description === 'string' ? parsed.description : null,
  };

  return NextResponse.json(result);
}
