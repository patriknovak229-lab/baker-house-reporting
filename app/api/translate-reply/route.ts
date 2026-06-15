/**
 * POST /api/translate-reply
 *
 * Body: { text: string, targetLang: string }
 * Returns: { translated: string }
 *
 * Translates a host's Czech reply into the guest's language using the SAME
 * Sonnet translator the send step uses (utils/translateReply.ts) — so the
 * operator's "Show translation" preview matches what actually gets sent.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { translateReplyToGuest } from '@/utils/translateReply';

export async function POST(req: NextRequest) {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  let body: { text?: string; targetLang?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const text = (body.text ?? '').trim();
  const targetLang = (body.targetLang ?? '').trim();
  if (!text) return NextResponse.json({ error: 'text is required' }, { status: 400 });
  if (!targetLang) return NextResponse.json({ error: 'targetLang is required' }, { status: 400 });

  try {
    const translated = await translateReplyToGuest(text, targetLang);
    return NextResponse.json({ translated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
