import { NextResponse } from 'next/server';
import sharp from 'sharp';
import { requireRole } from '@/utils/authGuard';
import { readAllInvoiceCategories } from '@/utils/invoiceCategoriesStore';
import { extractInvoice, ExtractionError } from '@/utils/invoiceExtraction';

// Opus extraction takes ~3–8 s per document; headroom for long multi-page PDFs
export const maxDuration = 60;

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

  if (mediaType !== 'application/pdf' && !mediaType.startsWith('image/')) {
    return NextResponse.json({ error: 'Unsupported file type. Upload a PDF or image.' }, { status: 400 });
  }

  try {
    const categories = await readAllInvoiceCategories();
    const extracted = await extractInvoice({ data: buffer, mediaType, fileName: file.name, categories });
    return NextResponse.json(extracted);
  } catch (err) {
    if (err instanceof ExtractionError) {
      return NextResponse.json({ error: err.message, raw: err.raw }, { status: err.status });
    }
    console.error('Invoice extraction failed:', err);
    return NextResponse.json({ error: 'Invoice extraction failed' }, { status: 502 });
  }
}
