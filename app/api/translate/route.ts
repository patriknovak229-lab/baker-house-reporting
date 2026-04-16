import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';

const GOOGLE_TRANSLATE_URL = 'https://translation.googleapis.com/language/translate/v2';

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

  const apiKey = process.env.GOOGLE_TRANSLATE_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'Translation service not configured' }, { status: 500 });
  }

  try {
    const res = await fetch(`${GOOGLE_TRANSLATE_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        q: text,
        target: targetLang,
        format: 'text',
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      const msg = data?.error?.message ?? `Google Translate returned ${res.status}`;
      return NextResponse.json({ error: msg }, { status: 502 });
    }

    const translation = data?.data?.translations?.[0];
    if (!translation) {
      return NextResponse.json({ error: 'No translation returned' }, { status: 502 });
    }

    return NextResponse.json({
      translatedText: translation.translatedText as string,
      detectedLanguage: (translation.detectedSourceLanguage as string) ?? '',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
