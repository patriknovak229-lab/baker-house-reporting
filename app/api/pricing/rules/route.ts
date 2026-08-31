/**
 * Parity alert-rule config — the Pricing tab's "Alert rules" editor saves
 * here. Colours follow immediately (the board evaluates the fetched config);
 * Telegram follows from the next grid ingest, which reads the same store.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { readParityRuleConfig, saveParityRuleConfig } from '@/data-access/pricing/rules';
import { sanitizeRuleConfig } from '@/utils/parityRules';

export const dynamic = 'force-dynamic';

export async function GET() {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;
  return NextResponse.json({ config: await readParityRuleConfig() });
}

export async function POST(req: NextRequest) {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  const body = await req.json().catch(() => null);
  const config = sanitizeRuleConfig(body?.config);
  if (!config) {
    return NextResponse.json(
      { error: 'Invalid rule config — each stay length needs a list of valid rules (max 12).' },
      { status: 400 },
    );
  }

  try {
    await saveParityRuleConfig(config, guard.email ?? null);
    return NextResponse.json({ config });
  } catch (err) {
    console.error('[pricing-rules]', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Save failed' },
      { status: 500 },
    );
  }
}
