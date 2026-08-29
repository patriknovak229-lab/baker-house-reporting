/**
 * Renders the annual commission overview to a PDF using REAL cleaning-app costs
 * and REAL issued settlements from Redis, plus synthetic bookings (the Beds24
 * token isn't available locally). Verification aid only — writes to the path
 * given as argv[2] and touches nothing.
 *
 *   npx tsx scripts/verify/annual-pdf-preview.ts /tmp/annual.pdf
 */
import '../_loadEnv';
import { writeFileSync } from 'node:fs';
import type { Reservation } from '@/types/reservation';
import { computeVariableCosts } from '@/utils/variableCostsEngine';
import { readAllCommissionSettlements } from '@/utils/commissionSettlementsStore';
import { buildAnnualOverview } from '@/utils/commissionYear';
import { buildAnnualOverviewHTML } from '@/utils/annualStatementHtml';
import { generatePDF } from '@/utils/pdfGenerate';

const ROOMS = ['K.102', 'K.103', 'K.106', 'K.201', 'K.202', 'K.203', 'O.308'];
const NIGHTLY: Record<string, number> = {
  'K.102': 9000, 'K.103': 9000, 'K.106': 9000,
  'K.201': 16000, 'K.202': 8000, 'K.203': 8000, 'O.308': 19000,
};

function fixtureBookings(year: number): Reservation[] {
  const out: Reservation[] = [];
  let n = 0;
  for (let m = 1; m <= 12; m += 1) {
    for (const room of ROOMS) {
      for (const day of [3, 12, 21]) {
        const iso = (d: Date) => d.toISOString().slice(0, 10);
        const ci = new Date(Date.UTC(year, m - 1, day));
        const co = new Date(Date.UTC(year, m - 1, day + 4));
        const price = Math.round(NIGHTLY[room] * (0.8 + ((m + day) % 5) * 0.1));
        out.push({
          reservationNumber: `BH-FIX${(n += 1)}`,
          firstName: 'Test', lastName: 'Guest', channel: 'Booking.com', room,
          checkInDate: iso(ci), checkOutDate: iso(co), reservationDate: iso(ci),
          bookingTimestamp: `${iso(ci)}T09:00:00Z`, numberOfNights: 4, numberOfGuests: 2,
          email: '', phone: '', nationality: 'CZ', price,
          commissionAmount: Math.round(price * 0.15), paymentChargeAmount: Math.round(price * 0.014),
          cleaningStatus: 'Completed', paymentStatus: 'Paid', amountPaid: price,
          additionalEmail: '', paymentStatusOverride: null, notes: '',
          manualFlagOverrides: {}, ratingStatus: 'None',
        } as unknown as Reservation);
      }
    }
  }
  return out;
}

async function main() {
  const outPath = process.argv[2] ?? '/tmp/annual.pdf';
  const year = Number(process.argv[3] ?? new Date().getFullYear());

  const costs = await computeVariableCosts();
  if (!costs) throw new Error('Redis not configured — cannot read cleaning-app costs');
  const settlements = await readAllCommissionSettlements();

  const overview = buildAnnualOverview(
    year,
    fixtureBookings(year),
    {
      byDateRoom: costs.byDateRoom,
      byReservation: costs.byReservation,
      subscriptionItems: costs.subscriptionItems,
      manualCleaningKeys: costs.manualCleaningKeys,
      noLaundryKeys: costs.noLaundryKeys,
      dismissedCleaningKeys: costs.dismissedCleaningKeys,
    },
    settlements,
  );

  console.log(`year=${year} activeMonths=${overview.activeMonths} rooms=${overview.rows.length}`);
  console.log('subscription lines:', overview.subscriptionLabels.join(' | '));
  console.log('business net sales:', Math.round(overview.total.total.netSales));
  console.log('business payable  :', Math.round(overview.total.total.payableToOwner));

  const html = buildAnnualOverviewHTML(overview);
  const htmlPath = outPath.replace(/\.pdf$/, '.html');
  writeFileSync(htmlPath, html);
  console.log(`wrote ${htmlPath} (${(html.length / 1024).toFixed(0)} KB)`);

  // Headless Chromium is flaky on some local machines; the HTML above is the
  // part this script is really checking, so a PDF failure must not mask it.
  try {
    const pdf = await generatePDF(html, { landscape: true });
    writeFileSync(outPath, pdf);
    console.log(`wrote ${outPath} (${(pdf.length / 1024).toFixed(0)} KB)`);
  } catch (err) {
    console.warn(`PDF step skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
