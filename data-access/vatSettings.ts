/**
 * VAT section settings — one app_settings row (no migration needed).
 *
 * Holds what the records can't tell us: the VAT registration date, the
 * signer / contact for the XML headers, the OTAs' own tax-document numbers
 * per settlement, and the operator's decisions on flagged items.
 */
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { appSettings } from '@/lib/db/schema';
import type { OtaTaxDocument, VatConfig, VatDecision, VatSettings } from '@/types/vat';
import { DEFAULT_VAT_CONFIG } from '@/utils/vat/config';
import { isValidIsoDate } from '@/utils/vat/czechCalendar';

const SETTING = 'vat-settings';
const DECISIONS: readonly VatDecision[] = ['merge', 'separate', 'include', 'exclude'];

export function defaultVatSettings(): VatSettings {
  return { config: { ...DEFAULT_VAT_CONFIG }, otaDocuments: {}, decisions: {} };
}

/** Coerce anything stored / posted into a well-formed VatSettings. Throws on invalid values. */
export function sanitizeVatSettings(raw: unknown): VatSettings {
  const src = (raw ?? {}) as Partial<VatSettings>;
  const base = defaultVatSettings();
  const cfgIn = (src.config ?? {}) as Partial<VatConfig>;
  const config: VatConfig = { ...base.config };
  const writable = config as unknown as Record<string, string | null>;
  for (const key of Object.keys(base.config) as Array<keyof VatConfig>) {
    if (key === 'payerFrom') continue;
    const v = cfgIn[key];
    if (typeof v === 'string') writable[key] = v.trim().slice(0, 255);
  }
  if (cfgIn.payerFrom === null || cfgIn.payerFrom === undefined || cfgIn.payerFrom === '') {
    config.payerFrom = null;
  } else if (typeof cfgIn.payerFrom === 'string' && isValidIsoDate(cfgIn.payerFrom)) {
    config.payerFrom = cfgIn.payerFrom;
  } else {
    throw new Error('payerFrom must be a date (YYYY-MM-DD) or empty');
  }

  const otaDocuments: Record<string, OtaTaxDocument[]> = {};
  for (const [groupId, docs] of Object.entries(src.otaDocuments ?? {})) {
    if (!Array.isArray(docs)) continue;
    const clean: OtaTaxDocument[] = [];
    for (const d of docs) {
      const doc = d as Partial<OtaTaxDocument>;
      const number = String(doc.number ?? '').trim();
      if (!number) continue;
      if (number.length > 60) throw new Error(`Document number “${number}” is longer than 60 characters`);
      if (!isValidIsoDate(doc.date ?? '')) throw new Error(`Document ${number}: date must be YYYY-MM-DD`);
      if (typeof doc.amountHal !== 'number' || !Number.isInteger(doc.amountHal)) {
        throw new Error(`Document ${number}: amount must be an integer number of haléře`);
      }
      clean.push({ number, date: doc.date!, amountHal: doc.amountHal });
    }
    if (clean.length > 0) otaDocuments[groupId] = clean;
  }

  const decisions: Record<string, VatDecision> = {};
  for (const [key, value] of Object.entries(src.decisions ?? {})) {
    if (DECISIONS.includes(value as VatDecision)) decisions[key] = value as VatDecision;
  }

  return { config, otaDocuments, decisions, updatedAt: src.updatedAt, updatedBy: src.updatedBy };
}

export async function readVatSettings(): Promise<VatSettings> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, SETTING)).limit(1);
  if (!row) return defaultVatSettings();
  try {
    return sanitizeVatSettings(row.value);
  } catch (err) {
    console.error('[vat] stored settings invalid, using defaults:', err);
    return defaultVatSettings();
  }
}

export async function writeVatSettings(next: VatSettings, by: string): Promise<VatSettings> {
  const value = { ...sanitizeVatSettings(next), updatedAt: new Date().toISOString(), updatedBy: by };
  await db
    .insert(appSettings)
    .values({ key: SETTING, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
  return value;
}
