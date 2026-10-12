import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { readVatSettings, sanitizeVatSettings, writeVatSettings } from '@/data-access/vatSettings';
import type { OtaTaxDocument, VatConfig, VatDecision } from '@/types/vat';

// GET /api/vat/settings — registration date, filing identity, OTA document numbers, flag decisions.
export async function GET() {
  const guard = await requireRole(['admin', 'accountant']);
  if ('error' in guard) return guard.error;
  return NextResponse.json(await readVatSettings());
}

interface SettingsPatch {
  config?: Partial<VatConfig>;
  /** groupId → documents; null or [] removes the entry. */
  otaDocuments?: Record<string, OtaTaxDocument[] | null>;
  /** decision key → decision; null resets to the engine default. */
  decisions?: Record<string, VatDecision | null>;
}

// PATCH-style PUT: merges into the stored settings so two edits can't clobber each other.
// Admin only (accounting mutations are admin-only).
export async function PUT(req: NextRequest) {
  const guard = await requireRole(['admin']);
  if ('error' in guard) return guard.error;
  let patch: SettingsPatch;
  try {
    patch = (await req.json()) as SettingsPatch;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  try {
    const current = await readVatSettings();
    const otaDocuments = { ...current.otaDocuments };
    for (const [groupId, docs] of Object.entries(patch.otaDocuments ?? {})) {
      if (!docs || docs.length === 0) delete otaDocuments[groupId];
      else otaDocuments[groupId] = docs;
    }
    const decisions = { ...current.decisions };
    for (const [key, decision] of Object.entries(patch.decisions ?? {})) {
      if (decision === null) delete decisions[key];
      else decisions[key] = decision;
    }
    const merged = sanitizeVatSettings({
      config: { ...current.config, ...(patch.config ?? {}) },
      otaDocuments,
      decisions,
    });
    return NextResponse.json(await writeVatSettings(merged, guard.email));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Invalid settings' }, { status: 400 });
  }
}
