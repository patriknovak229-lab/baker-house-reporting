/**
 * Cost bridge — maps each pragmatic cost category to a Czech ledger account
 * (účtová osnova) AND a VZZ statutory line, per the accountant's spec.
 *
 * SOURCE OF TRUTH: config/cost-category-bridge.csv (filed by the accountant).
 * This module mirrors that CSV. To change the mapping, edit both — the CSV is
 * the human/accountant-facing config; this is the typed runtime copy.
 *
 * Statutory lines (VZZ):
 *   A = Výkonová spotřeba
 *   D = Osobní náklady
 *   E = Úpravy hodnot v provozní oblasti (odpisy)
 *   F = Ostatní provozní náklady
 *
 * Company is treated as NON-VAT: use gross amountCZK, ignore vatAmountCZK.
 */
export type StatutoryLine = 'A' | 'D' | 'E' | 'F';

export interface BridgeEntry {
  account: string;      // Czech chart-of-accounts number
  accountName: string;
  line: StatutoryLine;
}

/** category → account + statutory line (mirror of config/cost-category-bridge.csv) */
export const COST_BRIDGE: Record<string, BridgeEntry> = {
  equipment:           { account: '501', accountName: 'Spotřeba materiálu (drobný hmotný majetek < 80k)', line: 'A' },
  consumables:         { account: '501', accountName: 'Spotřeba materiálu',   line: 'A' },
  'distribution-fees': { account: '518', accountName: 'Ostatní služby',        line: 'A' },
  other:               { account: '501', accountName: 'Spotřeba materiálu',   line: 'A' },
  maintenance:         { account: '511', accountName: 'Opravy a udržování',    line: 'A' },
  cleaning:            { account: '518', accountName: 'Ostatní služby',        line: 'A' },
  laundry:             { account: '518', accountName: 'Ostatní služby',        line: 'A' },
  services:            { account: '518', accountName: 'Ostatní služby',        line: 'A' },
  software:            { account: '518', accountName: 'Ostatní služby',        line: 'A' },
  utilities:           { account: '502', accountName: 'Spotřeba energie',      line: 'A' },
};

/** A single item ≥ this (CZK) in a capitalizable category is a durable fixed asset */
export const CAPITALIZATION_THRESHOLD = 80000;
const CAPITALIZABLE = new Set(['equipment', 'other']);

/** Fixed asset ≥ threshold → balance sheet (022); only annual depreciation lands on line E */
export const ASSET_ENTRY: BridgeEntry = { account: '022', accountName: 'Dlouhodobý hmotný majetek', line: 'E' };
/** Unknown category → other operating costs, flagged for review */
export const FALLBACK_ENTRY: BridgeEntry = { account: '548', accountName: 'Ostatní provozní náklady', line: 'F' };

/** Recurring bank costs with no invoice (rent, parking) → services on line A */
export const RECURRING_ENTRY: BridgeEntry = { account: '518', accountName: 'Ostatní služby', line: 'A' };

export const LINE_META: Record<StatutoryLine, { code: string; label: string }> = {
  A: { code: 'A.', label: 'Výkonová spotřeba' },
  D: { code: 'D.', label: 'Osobní náklady' },
  E: { code: 'E.', label: 'Úpravy hodnot v provozní oblasti' },
  F: { code: 'F.', label: 'Ostatní provozní náklady' },
};

export interface ClassifiedCost extends BridgeEntry {
  /** true when routed to a fixed asset (≥ threshold) — a balance-sheet item, NOT an operating expense */
  capitalized: boolean;
  /** true when the category was not in the bridge (fell back to 548/F) */
  unknownCategory: boolean;
}

/**
 * Classify a single cost record → ledger account + statutory line.
 * Pure function (unit-tested): capitalization guard first, then bridge, then fallback.
 */
export function classifyCost(category: string, amountCZK: number): ClassifiedCost {
  if (CAPITALIZABLE.has(category) && amountCZK >= CAPITALIZATION_THRESHOLD) {
    return { ...ASSET_ENTRY, capitalized: true, unknownCategory: false };
  }
  const entry = COST_BRIDGE[category];
  if (entry) return { ...entry, capitalized: false, unknownCategory: false };
  return { ...FALLBACK_ENTRY, capitalized: false, unknownCategory: true };
}
