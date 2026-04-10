import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import sharp from 'sharp';
import { requireRole } from '@/utils/authGuard';
import type { ExtractedInvoiceData } from '@/types/supplierInvoice';

const EXTRACTION_PROMPT = `Extract structured data from this supplier invoice or fee statement (Czech or English).
Return ONLY valid JSON, no other text:
{
  "supplierName": string or null,
  "supplierICO": string or null,
  "invoiceNumber": string or null,
  "invoiceDate": "YYYY-MM-DD" or null,
  "dueDate": "YYYY-MM-DD" or null,
  "totalAmount": number or null,
  "invoiceCurrency": "CZK"|"USD"|"EUR"|"GBP" or null,
  "vatAmount": number or null,
  "suggestedCategory": one of "cleaning"|"laundry"|"consumables"|"utilities"|"software"|"maintenance"|"other" or null,
  "lineItems": [{"description": string, "amount": number}] or null
}
totalAmount: the total amount payable (including VAT if present). Extract the number as shown on the invoice regardless of currency.
invoiceCurrency: the currency of the invoice (CZK, USD, EUR, GBP, etc.).
lineItems: If the document is a fee statement or service summary with a table of multiple reservations or transactions each with an individual fee amount (e.g. an Airbnb monthly service fee statement), extract each row as a lineItem with description (reservation reference or guest name) and amount (the fee for that row). Set totalAmount to the SUM of all row fees — do NOT use any pre-printed grand total which may include VAT or other charges. If there is only one total with no per-row breakdown, set lineItems to null.
If a field cannot be determined, use null.`;

const CLAUDE_MAX_BYTES = 4.5 * 1024 * 1024; // 4.5 MB — leave headroom under the 5 MB API limit

function isHeic(mimeType: string, fileName: string): boolean {
  if (mimeType.startsWith('image/heic') || mimeType.startsWith('image/heif')) return true;
  const ext = fileName.split('.').pop()?.toLowerCase();
  return ext === 'heic' || ext === 'heif';
}

export async function POST(request: Request) {
  const guard = await requireRole(['admin']);
  if ('error' in guard) return guard.error;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 503 });

  const formData = await request.formData();
  const file = formData.get('file') as File | null;

  if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 });

  const bytes = await file.arrayBuffer();
  // eslint-disable-next-line prefer-const
  let buffer: Buffer = Buffer.from(bytes);
  let mediaType = file.type || 'application/octet-stream';

  // ── HEIC/HEIF → JPEG (server-side, using sharp's pre-built libvips binaries) ──
  if (isHeic(mediaType, file.name)) {
    try {
      buffer = await sharp(buffer).jpeg({ quality: 85 }).toBuffer();
      mediaType = 'image/jpeg';
    } catch (err) {
      console.error('HEIC→JPEG conversion failed:', err);
      return NextResponse.json(
        { error: 'Could not convert HEIC image. Please export as JPEG from Photos and try again.' },
        { status: 415 },
      );
    }
  }

  // ── Large image → fit within Claude's 5 MB limit ──
  // Strategy: reduce JPEG quality first (keeps full resolution, text stays sharp).
  // Only shrink dimensions as a last resort — scaling down a receipt makes text unreadable.
  if (mediaType.startsWith('image/') && buffer.length > CLAUDE_MAX_BYTES) {
    try {
      let compressed: Buffer | null = null;
      for (const quality of [75, 60, 45]) {
        const candidate = await sharp(buffer).jpeg({ quality }).toBuffer();
        if (candidate.length <= CLAUDE_MAX_BYTES) {
          compressed = candidate;
          break;
        }
      }
      if (!compressed) {
        // Extreme fallback: cap longest edge at 3500 px then re-try quality steps
        // 3500 px keeps ~300 DPI for an A4-sized document — still very readable
        const resized = await sharp(buffer)
          .resize({ width: 3500, height: 3500, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 60 })
          .toBuffer();
        compressed = resized.length <= CLAUDE_MAX_BYTES ? resized : null;
      }
      if (compressed) {
        buffer = compressed;
        mediaType = 'image/jpeg';
      }
    } catch { /* leave buffer as-is — Claude will reject if truly too large */ }
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
    max_tokens: 2048,
    messages: [{ role: 'user', content }],
  });

  const rawText = message.content
    .filter((b) => b.type === 'text')
    .map((b) => (b as { type: 'text'; text: string }).text)
    .join('');

  let extracted: ExtractedInvoiceData;
  try {
    const jsonText = rawText.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    const rawLineItems = Array.isArray(parsed.lineItems) ? parsed.lineItems : null;
    const lineItems = rawLineItems
      ? rawLineItems
          .filter((item): item is { description: string; amount: number } =>
            item !== null &&
            typeof item === 'object' &&
            typeof (item as Record<string, unknown>).description === 'string' &&
            typeof (item as Record<string, unknown>).amount === 'number',
          )
          .map((item) => ({ description: item.description, amount: item.amount }))
      : null;

    // If lineItems were extracted, use their sum as the canonical amount
    const lineItemSum = lineItems && lineItems.length > 0
      ? lineItems.reduce((s, i) => s + i.amount, 0)
      : null;

    extracted = {
      supplierName: typeof parsed.supplierName === 'string' ? parsed.supplierName : null,
      supplierICO: typeof parsed.supplierICO === 'string' ? parsed.supplierICO : null,
      invoiceNumber: typeof parsed.invoiceNumber === 'string' ? parsed.invoiceNumber : null,
      invoiceDate: typeof parsed.invoiceDate === 'string' ? parsed.invoiceDate : null,
      dueDate: typeof parsed.dueDate === 'string' ? parsed.dueDate : null,
      amountCZK: lineItemSum ?? (typeof parsed.totalAmount === 'number' ? parsed.totalAmount : null),
      vatAmountCZK: typeof parsed.vatAmount === 'number' ? parsed.vatAmount : null,
      invoiceCurrency: typeof parsed.invoiceCurrency === 'string' ? parsed.invoiceCurrency : null,
      suggestedCategory: typeof parsed.suggestedCategory === 'string' ? parsed.suggestedCategory : null,
      lineItems: lineItems && lineItems.length > 0 ? lineItems : null,
    };
  } catch {
    return NextResponse.json({ error: 'Failed to parse extraction response', raw: rawText }, { status: 502 });
  }

  return NextResponse.json(extracted);
}
