import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { translateText } from '@/utils/googleTranslate';

/**
 * POST /api/translate
 *
 * Body: { text: string, targetLang?: string (defaults to 'cs') }
 * Returns: { translatedText, detectedLanguage }
 *
 * Thin wrapper around utils/googleTranslate.ts. Server-side callers (the
 * Beds24 message webhook) call the helper directly to avoid NextAuth.
 */
export async function POST(req: NextRequest) {
  const authResult = await requireRole(['admin', 'super']);
  if ('error' in authResult) return authResult.error;

  const { text, targetLang = 'cs' } = (await req.json()) as {
    text?: string;
    targetLang?: string;
  };

  if (!text || !text.trim()) {
    return NextResponse.json({ error: 'text is required' }, { status: 400 });
  }

  try {
    const result = await translateText(text, targetLang);
    if (!result) {
      return NextResponse.json({ error: 'Translation service not configured' }, { status: 500 });
    }
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
