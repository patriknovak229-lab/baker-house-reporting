/**
 * Supplier-invoice extraction — Claude call + deterministic post-processing.
 *
 * Used by app/api/supplier-invoices/extract (which handles auth + image
 * conversion) and by local evaluation scripts, so the model call, the prompt and
 * the clean-up rules live in one place.
 *
 * Post-processing (code, not the model, decides):
 *   - money rounded to 2 decimals
 *   - receipts printed without a year get the year from the printed weekday
 *   - credit notes (dobropis) get negative amounts
 *   - line items only drive the total for fee statements (Airbnb)
 *   - known recurring suppliers get a canonical name / IČO / category
 */
import Anthropic from '@anthropic-ai/sdk';
import { SUPPLIER_KNOWLEDGE } from '@/utils/supplierKnowledge';
import { findKnownSupplier, normalizeIco } from '@/utils/supplierRegistry';
import { resolveMissingYear, round2, round2OrNull, OUR_ICO } from '@/utils/invoiceChecks';
import type { ExtractedInvoiceData, ExtractedVatRow, InvoiceCategory } from '@/types/supplierInvoice';

const MODEL = 'claude-sonnet-5-5';

const DOCUMENT_TYPES = ['invoice', 'credit_note', 'receipt', 'fee_statement', 'order_summary', 'other'] as const;
const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] });
const DATE = { type: 'string', format: 'date' };

function outputSchema(categoryIds: string[]) {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'documentType', 'supplierName', 'supplierICO', 'invoiceNumber', 'originalInvoiceNumber',
      'invoiceDate', 'invoiceDateHasYear', 'invoiceWeekday', 'duzpDate', 'dueDate',
      'currency', 'totalAmount', 'vatAmount', 'vatBreakdown', 'suggestedCategory', 'lineItems',
    ],
    properties: {
      documentType: { type: 'string', enum: [...DOCUMENT_TYPES] },
      supplierName: nullable({ type: 'string' }),
      supplierICO: nullable({ type: 'string' }),
      invoiceNumber: nullable({ type: 'string' }),
      originalInvoiceNumber: nullable({ type: 'string' }),
      invoiceDate: nullable(DATE),
      invoiceDateHasYear: { type: 'boolean' },
      invoiceWeekday: nullable({ type: 'string', enum: WEEKDAY_NAMES }),
      duzpDate: nullable(DATE),
      dueDate: nullable(DATE),
      currency: nullable({ type: 'string' }),
      totalAmount: nullable({ type: 'number' }),
      vatAmount: nullable({ type: 'number' }),
      vatBreakdown: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['rate', 'base', 'vat'],
          properties: {
            rate: { type: 'number' },
            base: nullable({ type: 'number' }),
            vat: nullable({ type: 'number' }),
          },
        },
      },
      suggestedCategory: nullable({ type: 'string', enum: categoryIds }),
      lineItems: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['description', 'amount'],
          properties: { description: { type: 'string' }, amount: { type: 'number' } },
        },
      },
    },
  };
}

interface ModelOutput {
  documentType: (typeof DOCUMENT_TYPES)[number];
  supplierName: string | null;
  supplierICO: string | null;
  invoiceNumber: string | null;
  originalInvoiceNumber: string | null;
  invoiceDate: string | null;
  invoiceDateHasYear: boolean;
  invoiceWeekday: string | null;
  duzpDate: string | null;
  dueDate: string | null;
  currency: string | null;
  totalAmount: number | null;
  vatAmount: number | null;
  vatBreakdown: ExtractedVatRow[];
  suggestedCategory: string | null;
  lineItems: { description: string; amount: number }[];
}

function buildPrompt(categories: InvoiceCategory[], fileName: string, today: string): string {
  const categoryList = categories.map((c) => `- ${c.id} (${c.label})`).join('\n');
  return `You are extracting bookkeeping data from a supplier document (Czech or English) for Truthseeker s.r.o., a Czech company that runs short-term rental apartments. Truthseeker s.r.o. (IČO ${OUR_ICO}, DIČ CZ${OUR_ICO}) is always the BUYER — never report its name or IČO as the supplier.

Context: today is ${today}. The file is named "${fileName}" (the name may contain the purchase date, but the document itself is authoritative).

Fill the JSON schema as follows. Use null for anything the document does not show; never invent values.

documentType
- "credit_note" for a dobropis / opravný daňový doklad / credit note (a refund or return that reduces what we owe).
- "fee_statement" only for multi-row fee statements without one applicable total (e.g. the Airbnb monthly service-fee statement).
- "receipt" for till / e-shop receipts (účtenka, zjednodušený daňový doklad), "order_summary" for order confirmations that are not tax documents, otherwise "invoice".

supplierName / supplierICO: the seller (Dodavatel / Prodávající). supplierICO is the 8-digit IČO, digits only. For foreign suppliers with no IČO use their VAT id (e.g. DE328454604).

invoiceNumber: the document number (Číslo faktury / dokladu, receipt or transaction number). Not an order number, variable symbol or customer number unless the document has no other number.
originalInvoiceNumber: credit notes only — the number of the original invoice / tax document being corrected (e.g. "k faktuře č.", "Původní doklad", "Opravovaný doklad"). Otherwise null.

Dates, all YYYY-MM-DD:
- invoiceDate: date of issue (Datum vystavení), or the purchase date on a receipt.
- invoiceDateHasYear: false when the document prints the date WITHOUT a year (e.g. "Středa 19. srpna"); then put your best-guess year in invoiceDate and set invoiceWeekday to the printed weekday (Středa = Wednesday, …). When the year is printed, set true and invoiceWeekday to null.
- duzpDate: the taxable-supply date (DUZP / Datum uskutečnění zdanitelného plnění) only when it is printed; otherwise null.
- dueDate: Datum splatnosti, otherwise null.

Amounts (numbers as printed, in the document's currency; currency as an ISO code such as CZK, EUR, USD):
- totalAmount: the printed grand total INCLUDING VAT (e.g. "Celkem", "Celková částka", "Cena celkem", "K zaplacení celkem", "Total"). Read it — do not recompute it from line items. When the amount still to pay is 0 because the order was prepaid (e.g. "Celkem k úhradě 0,00", "Uhrazeno předem"), use the invoice value, not 0. For a credit note give the credited amount as a positive number.
- vatAmount: total VAT (DPH) as printed; sum across rates when VAT is split between 12 % and 21 %. null when no Czech VAT is shown (reverse charge, foreign supplier, non-VAT payer). Positive for credit notes too.
- vatBreakdown: one row per rate from the VAT recap table ("Rekapitulace DPH", "Přehled DPH", "DPH z"): rate in percent, base = amount WITHOUT VAT, vat = the VAT. If only the gross per rate is printed, base = gross − vat. Empty array when there is no VAT table.

suggestedCategory: the best fit from this list, or null:
${categoryList}

lineItems: only for documentType "fee_statement" — one row per reservation / transaction with its fee. Empty array for every other document type.

SUPPLIER-SPECIFIC GUIDANCE
If the document is from one of these suppliers (match by name or IČO), apply its notes on top of the rules above; otherwise ignore this section.
${SUPPLIER_KNOWLEDGE}`;
}

export class ExtractionError extends Error {
  constructor(message: string, public status: number, public raw?: string) {
    super(message);
  }
}

export interface ExtractInput {
  data: Buffer;
  /** application/pdf or image/jpeg|png|gif|webp */
  mediaType: string;
  fileName: string;
  categories: InvoiceCategory[];
  today?: Date;
}

/** Call Claude on one document and return cleaned-up invoice data. */
export async function extractInvoice(input: ExtractInput, client = new Anthropic()): Promise<ExtractedInvoiceData> {
  const today = input.today ?? new Date();
  const todayIso = today.toISOString().slice(0, 10);
  const base64 = input.data.toString('base64');

  let docBlock: Anthropic.Beta.BetaContentBlockParam;
  if (input.mediaType === 'application/pdf') {
    docBlock = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } };
  } else if (input.mediaType.startsWith('image/')) {
    const SUPPORTED = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
    const imgType = (SUPPORTED as readonly string[]).includes(input.mediaType)
      ? (input.mediaType as (typeof SUPPORTED)[number])
      : 'image/jpeg';
    docBlock = { type: 'image', source: { type: 'base64', media_type: imgType, data: base64 } };
  } else {
    throw new ExtractionError('Unsupported file type. Upload a PDF or image.', 400);
  }

  const categoryIds = input.categories.map((c) => c.id);
  const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    output_config: { effort: 'high', format: { type: 'json_schema', schema: outputSchema(categoryIds) } },
    messages: [{
      role: 'user',
      content: [docBlock, { type: 'text', text: buildPrompt(input.categories, input.fileName, todayIso) }],
    }],
  };
  // Server-side refusal fallback: if a safety classifier declines, the API retries
  // on a fallback model inside the same call. `fallbacks` is newer than SDK 0.82's types.
  const message = await client.beta.messages.create({ ...params, ...({ fallbacks: 'default' } as object) });

  if (message.stop_reason === 'refusal') throw new ExtractionError('The model declined to read this document.', 422);
  if (message.stop_reason === 'max_tokens') throw new ExtractionError('Extraction was cut off (output too long).', 502);

  const rawText = message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  let p: ModelOutput;
  try {
    p = JSON.parse(rawText) as ModelOutput;
  } catch {
    throw new ExtractionError('Failed to parse extraction response', 502, rawText);
  }
  return postProcess(p, input.categories, today);
}

/** Deterministic clean-up of the model output. Exported for tests. */
export function postProcess(p: ModelOutput, categories: InvoiceCategory[], today: Date = new Date()): ExtractedInvoiceData {
  const isCredit = p.documentType === 'credit_note';
  const isFeeStatement = p.documentType === 'fee_statement';

  let invoiceDate = p.invoiceDate;
  if (invoiceDate && !p.invoiceDateHasYear) invoiceDate = resolveMissingYear(invoiceDate, p.invoiceWeekday, today);

  const lineItems = isFeeStatement
    ? p.lineItems.map((i) => ({ description: i.description, amount: round2(i.amount) }))
    : [];
  const lineItemSum = lineItems.length > 0 ? lineItems.reduce((s, i) => s + i.amount, 0) : null;

  // Credit notes are stored negative so they net off the original invoice everywhere
  const signed = (n: number | null) => (n == null ? null : isCredit ? -Math.abs(n) : n);
  const amount = round2OrNull(signed(lineItemSum ?? p.totalAmount));
  const vat = round2OrNull(signed(p.vatAmount));

  const vatBreakdown = p.vatBreakdown.map((r) => ({
    rate: r.rate,
    base: round2OrNull(r.base),
    vat: round2OrNull(r.vat),
  }));

  const known = findKnownSupplier(p.supplierName, p.supplierICO);
  const extractedIco = normalizeIco(p.supplierICO) || null;
  const categoryIds = new Set(categories.map((c) => c.id));
  const modelCategory = p.suggestedCategory && categoryIds.has(p.suggestedCategory) ? p.suggestedCategory : null;

  return {
    supplierName: known?.name ?? p.supplierName,
    supplierICO: known?.ico ?? extractedIco,
    invoiceNumber: p.invoiceNumber?.trim() || null,
    invoiceDate,
    duzpDate: p.duzpDate,
    dueDate: p.dueDate,
    amountCZK: amount,
    vatAmountCZK: vat,
    invoiceCurrency: p.currency ? p.currency.toUpperCase() : null,
    suggestedCategory: known && categoryIds.has(known.category) ? known.category : modelCategory,
    lineItems: lineItems.length > 0 ? lineItems : null,
    documentType: isCredit ? 'credit_note' : 'invoice',
    originalInvoiceNumber: isCredit ? (p.originalInvoiceNumber?.trim() || null) : null,
    vatBreakdown: vatBreakdown.length > 0 ? vatBreakdown : null,
    knownSupplierId: known?.id ?? null,
  };
}
