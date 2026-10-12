/**
 * ČNB exchange rates for VAT (§ 4(8) ZDPH: the ČNB rate valid on the day the
 * tax obligation arises). One request per year — the yearly file lists every
 * fixing — cached in memory. The rate valid on a weekend / holiday is the last
 * fixing before it.
 */
import type { FxLookup, FxRate } from './engine';

const YEAR_URL = 'https://www.cnb.cz/cs/financni-trhy/devizovy-trh/kurzy-devizoveho-trhu/kurzy-devizoveho-trhu/rok.txt';

export interface YearTable {
  year: number;
  /** ISO dates of fixings, ascending. */
  dates: string[];
  rates: Map<string, Map<string, { rateMilli: number; unit: number }>>;
}

/** Parse the ČNB yearly TXT ("Datum|1 AUD|…|100 JPY|…" then "02.01.2026|13,797|…"). */
export function parseYearTable(year: number, text: string): YearTable {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const table: YearTable = { year, dates: [], rates: new Map() };
  let columns: Array<{ unit: number; code: string } | null> = [];
  for (const line of lines) {
    const cells = line.split('|');
    if (cells[0] === 'Datum') {
      // A year can contain several header lines when the currency list changes
      columns = cells.slice(1).map((h) => {
        const m = /^(\d+)\s+([A-Z]{3})$/.exec(h.trim());
        return m ? { unit: Number(m[1]), code: m[2] } : null;
      });
      continue;
    }
    const dm = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(cells[0]);
    if (!dm) continue;
    const iso = `${dm[3]}-${dm[2]}-${dm[1]}`;
    const day = new Map<string, { rateMilli: number; unit: number }>();
    cells.slice(1).forEach((raw, i) => {
      const col = columns[i];
      const value = raw.trim().replace(',', '.');
      if (!col || value === '') return;
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) return;
      day.set(col.code, { rateMilli: Math.round(n * 1000), unit: col.unit });
    });
    if (day.size > 0) {
      table.rates.set(iso, day);
      table.dates.push(iso);
    }
  }
  table.dates.sort();
  return table;
}

const cache = new Map<number, { fetchedAt: number; table: YearTable }>();

async function yearTable(year: number): Promise<YearTable | null> {
  const now = Date.now();
  const currentYear = new Date().getUTCFullYear();
  const ttl = year < currentYear ? 30 * 86_400_000 : 3 * 3_600_000;
  const hit = cache.get(year);
  if (hit && now - hit.fetchedAt < ttl) return hit.table;
  try {
    const res = await fetch(`${YEAR_URL}?rok=${year}`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`ČNB HTTP ${res.status}`);
    const table = parseYearTable(year, await res.text());
    if (table.dates.length === 0) throw new Error('ČNB file had no rows');
    cache.set(year, { fetchedAt: now, table });
    return table;
  } catch (err) {
    console.error(`[vat/cnb] rates for ${year} unavailable:`, err);
    return hit?.table ?? null; // stale beats nothing
  }
}

/** Pure lookup over loaded tables: the last fixing on or before `date`. */
export function lookupRate(tables: YearTable[], currency: string, date: string): FxRate | null {
  const cur = currency.toUpperCase();
  const sorted = [...tables].sort((a, b) => b.year - a.year);
  for (const t of sorted) {
    if (t.year > Number(date.slice(0, 4))) continue;
    for (let i = t.dates.length - 1; i >= 0; i--) {
      const d = t.dates[i];
      if (d > date) continue;
      const r = t.rates.get(d)?.get(cur);
      if (r) return { rateMilli: r.rateMilli, unit: r.unit, fixingDate: d };
    }
  }
  return null;
}

/** Load the years needed for `dates` (plus the year before, for 1 January) and return a sync lookup. */
export async function loadFxLookup(dates: string[]): Promise<FxLookup> {
  const years = new Set<number>();
  for (const d of dates) {
    const y = Number(d.slice(0, 4));
    if (Number.isFinite(y)) { years.add(y); years.add(y - 1); }
  }
  const tables = (await Promise.all([...years].map((y) => yearTable(y)))).filter((t): t is YearTable => t !== null);
  return (currency, date) => lookupRate(tables, currency, date);
}
