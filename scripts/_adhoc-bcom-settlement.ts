// TEMPORARY ad-hoc read-only reconciliation. Do not commit.
import './_loadEnv';
import { readFileSync } from 'fs';
import { sql } from 'drizzle-orm';
import { db } from '../lib/db';

const CSV = process.argv[2];

/** RFC-ish CSV line splitter (quoted fields may contain commas). */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ;
    } else if (c === ',' && !inQ) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const CZ_MONTHS: Record<string, string> = {
  ledna: '01', února: '02', března: '03', dubna: '04', května: '05', června: '06',
  července: '07', srpna: '08', září: '09', října: '10', listopadu: '11', prosince: '12',
};
function czDate(s: string): string {
  const m = s.trim().match(/^(\d{1,2})\.\s*([^\s]+)\s+(\d{4})$/);
  if (!m) return s;
  return `${m[3]}-${CZ_MONTHS[m[2]] ?? '??'}-${m[1].padStart(2, '0')}`;
}
const num = (s: string) => Number(s.replace(/\s/g, ''));

type Row = {
  type: string; ref: string; arrival: string; checkout: string; guest: string;
  psp: string; status: string; currency: string; payStatus: string;
  gross: number; commission: number; payFee: number; net: number; payoutDate: string; payId: string;
};

const lines = readFileSync(CSV, 'utf8').split(/\r?\n/).filter((l) => l.trim().length > 0);
const rows: Row[] = lines.slice(1).map((l) => {
  const f = splitCsvLine(l);
  return {
    type: f[0], ref: f[1], arrival: czDate(f[2]), checkout: czDate(f[3]), guest: f[4],
    psp: f[5], status: f[6], currency: f[7], payStatus: f[8],
    gross: num(f[9]), commission: num(f[10]), payFee: num(f[11]), net: num(f[12]),
    payoutDate: czDate(f[13]), payId: f[14],
  };
});

async function main() {
  const refs = rows.map((r) => r.ref);
  if (refs.some((r) => !/^\d+$/.test(r))) throw new Error('unexpected non-numeric reservation ref');
  const refList = sql.raw(refs.map((r) => `'${r}'`).join(','));
  const q = await db.execute(sql`
    select reservation_number, beds24_id, api_reference, room, linked_rooms,
           check_in_date, check_out_date, number_of_nights,
           first_name, last_name, price::float8 as price,
           commission_amount::float8 as commission_amount,
           payment_charge_amount::float8 as payment_charge_amount,
           amount_paid::float8 as amount_paid,
           payment_status, status, is_cancelled, is_unallocated_vr, rate_type,
           raw->>'apiSourceId' as api_source_id, raw->>'status' as raw_status,
           raw->>'apiMessage' as api_message
    from bookings_mirror
    where source = 'beds24-booking'
      and channel = 'Booking.com'
      and (api_reference in (${refList}) or (check_out_date >= '2026-08-01' and check_out_date <= '2026-08-31'))
    order by check_out_date, last_name
  `);
  const db_rows = (q as unknown as { rows: any[] }).rows;
  console.log(JSON.stringify({ csvRows: rows.length, dbRows: db_rows.length }, null, 2));
  console.log('===CSV===');
  console.log(JSON.stringify(rows));
  console.log('===DB===');
  console.log(JSON.stringify(db_rows));
}
main().catch((e) => { console.error(e); process.exit(1); });
