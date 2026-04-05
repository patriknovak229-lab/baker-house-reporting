import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { requireRole } from '@/utils/authGuard';
import type { ExtractedInvoiceData, SupplierInvoiceCategory } from '@/types/supplierInvoice';

const VALID_CATEGORIES: SupplierInvoiceCategory[] = [
  'cleaning', 'laundry', 'consumables', 'utilities', 'software', 'maintenance', 'other',
];

const EXTRACTION_PROMPT = `Extract structured data from this supplier invoice (Czech or English).
Return ONLY valid JSON, no other text:
{
  "supplierName": string or null,
  "supplierICO": string or null,
  "invoiceNumber": string or null,
  "invoiceDate": "YYYY-MM-DD" or null,
  "dueDate": "YYYY-MM-DD" or null,
  "amountCZK": number or null,
  "vatAmountCZK": number or null,
  "suggestedCategory": one of "cleaning"|"laundry"|"consumables"|"utilities"|"software"|"maintenance"|"other" or null
}
amountCZK should be the total amount payable (including VAT if present).
If a field cannot be determined, use null.`;

export async function POST(request: Request) {
  const guard = await requireRole(['admin']);
  if ('error' in guard) return guard.error;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 503 });

  const formData = await request.formData();
  const file = formData.get('file') as File | null;

  if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 });

  const bytes = await file.arrayBuffer();
  const buffer = Buffer.from(bytes);
  const base64 = buffer.toString('base64');
  const mediaType = file.type || 'application/octet-stream';

  const client = new Anthropic({ apiKey });

  let content: Anthropic.MessageParam['content'];

  if (mediaType === 'application/pdf') {
    content = [
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: base64 },
      },
      { type: 'text', text: EXTRACTION_PROMPT },
    ];
  } else if (mediaType.startsWith('image/')) {
    const imgType = mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
    content = [
      {
        type: 'image',
        source: { type: 'base64', media_type: imgType, data: base64 },
      },
      { type: 'text', text: EXTRACTION_PROMPT },
    ];
  } else {
    return NextResponse.json({ error: 'Unsupported file type. Upload a PDF or image.' }, { status: 400 });
  }

  const message = await client.messages.create({
    model: 'claude-3-5-haiku-20241022',
    max_tokens: 512,
    messages: [{ role: 'user', content }],
  });

  const rawText = message.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { type: 'text'; text: string }).text)
    .join('');

  let extracted: ExtractedInvoiceData;
  try {
    // Strip markdown code fences if present
    const jsonText = rawText.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    extracted = {
      supplierName: typeof parsed.supplierName === 'string' ? parsed.supplierName : null,
      supplierICO: typeof parsed.supplierICO === 'string' ? parsed.supplierICO : null,
      invoiceNumber: typeof parsed.invoiceNumber === 'string' ? parsed.invoiceNumber : null,
      invoiceDate: typeof parsed.invoiceDate === 'string' ? parsed.invoiceDate : null,
      dueDate: typeof parsed.dueDate === 'string' ? parsed.dueDate : null,
      amountCZK: typeof parsed.amountCZK === 'number' ? parsed.amountCZK : null,
      vatAmountCZK: typeof parsed.vatAmountCZK === 'number' ? parsed.vatAmountCZK : null,
      suggestedCategory:
        typeof parsed.suggestedCategory === 'string' &&
        VALID_CATEGORIES.includes(parsed.suggestedCategory as SupplierInvoiceCategory)
          ? (parsed.suggestedCategory as SupplierInvoiceCategory)
          : null,
    };
  } catch {
    return NextResponse.json({ error: 'Failed to parse extraction response', raw: rawText }, { status: 502 });
  }

  return NextResponse.json(extracted);
}
