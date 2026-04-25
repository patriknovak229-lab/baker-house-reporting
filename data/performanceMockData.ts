import type { Room } from "@/types/reservation";

// ── Currency ─────────────────────────────────────────────────────────────────
// All prices in sampleData are stored in EUR; the property runs on CZK.
// This rate is applied in all performance calculations.
export const EUR_TO_CZK = 25;

// ── Rooms config ─────────────────────────────────────────────────────────────
export const ALL_ROOMS: Room[] = ["K.201", "K.202", "K.203", "O.308"];

// ── Channel cost config ───────────────────────────────────────────────────────
// commissionRate: % of GBV taken by the platform as their fee
// paymentFeeRate: % of GBV charged for payment processing
// Note: Booking.com handles payment itself (no Stripe); Direct uses Stripe; Airbnb has no separate payment fee.
export const CHANNEL_COSTS: Record<
  string,
  { commissionRate: number; paymentFeeRate: number }
> = {
  "Booking.com": { commissionRate: 0.15, paymentFeeRate: 0.015 },
  Airbnb: { commissionRate: 0.03, paymentFeeRate: 0 },
  Direct: { commissionRate: 0, paymentFeeRate: 0.014 },
};

// ── Variable costs per reservation (CZK) ─────────────────────────────────────
// Sourced from cleaning app — not all items may be populated yet in production.
// cleaning: cleaning service cost, laundry: linen/towel laundry, consumables: minibar/coffee/toiletries
export interface VariableCosts {
  cleaning: number;
  laundry: number;
  consumables: number;
}

export const VARIABLE_COSTS: Record<string, VariableCosts> = {
  // ── March 2026 ────────────────────────────────────────────────────────────
  "BH-2026-00201": { cleaning: 850, laundry: 400, consumables: 280 },  // Martin Dvořák, Apt 101, 3n
  "BH-2026-00202": { cleaning: 950, laundry: 480, consumables: 320 },  // Sophie Müller, Apt 202, 4n
  "BH-2026-00195": { cleaning: 950, laundry: 500, consumables: 350 },  // Marco Ferrari, Apt 202, 5n
  "BH-2026-00190": { cleaning: 750, laundry: 380, consumables: 200 },  // Karolína Šimánková, Apt 303, 3n (refunded)

  // ── Upcoming (Apr–Jun 2026) ───────────────────────────────────────────────
  "BH-2026-00203": { cleaning: 1050, laundry: 520, consumables: 380 }, // Jan Novák, Apt 303, 5n
  "BH-2026-00204": { cleaning: 850, laundry: 400, consumables: 260 },  // Luca Rossi, Apt 101, 3n
  "BH-2026-00205": { cleaning: 1100, laundry: 580, consumables: 420 }, // Anna Kowalski, Apt 303, 7n
  "BH-2026-00206": { cleaning: 900, laundry: 420, consumables: 290 },  // James Thompson, Apt 202, 3n
  "BH-2026-00207": { cleaning: 920, laundry: 460, consumables: 310 },  // Petra Horáková, Apt 202, 4n
  "BH-2026-00208": { cleaning: 870, laundry: 430, consumables: 275 },  // Erik Svensson, Apt 101, 4n
  "BH-2026-00209": { cleaning: 1080, laundry: 560, consumables: 400 }, // Isabelle Dupont, Apt 303, 7n
  "BH-2026-00210": { cleaning: 890, laundry: 450, consumables: 310 },  // Tomáš Blažek, Apt 101, 6n

  // ── February 2026 ────────────────────────────────────────────────────────
  "BH-2026-00180": { cleaning: 800, laundry: 380, consumables: 230 },  // Dmitri Volkov, Apt 101, 2n
  "BH-2026-00171": { cleaning: 1050, laundry: 560, consumables: 410 }, // Claire Beaumont, Apt 303, 7n

  // ── January 2026 ─────────────────────────────────────────────────────────
  "BH-2026-00162": { cleaning: 870, laundry: 420, consumables: 290 },  // Ondřej Kratochvíl, Apt 202, 3n

  // ── Dec 2025 – Jan 2026 ──────────────────────────────────────────────────
  "BH-2025-00148": { cleaning: 920, laundry: 470, consumables: 360 },  // Hans Bergmann, Apt 101, 6n

  // ── December 2025 ────────────────────────────────────────────────────────
  "BH-2025-00139": { cleaning: 950, laundry: 490, consumables: 330 },  // Natalia Wiśniewska, Apt 202, 5n

  // ── November 2025 ────────────────────────────────────────────────────────
  "BH-2025-00128": { cleaning: 800, laundry: 390, consumables: 245 },  // Marek Procházka, Apt 303, 3n
  "BH-2025-00088": { cleaning: 870, laundry: 410, consumables: 270 },  // Martin Dvořák, Apt 202, 3n (first stay)

  // ── October 2025 ─────────────────────────────────────────────────────────
  "BH-2025-00115": { cleaning: 950, laundry: 490, consumables: 340 },  // Oliver Schneider, Apt 202, 5n

  // ── September 2025 ───────────────────────────────────────────────────────
  "BH-2025-00102": { cleaning: 1050, laundry: 550, consumables: 390 }, // Lucia García, Apt 101, 7n
};

// ── Fixed costs (monthly, CZK) ────────────────────────────────────────────────
// These will eventually be user-configurable in the Accounting tab.
export interface FixedCostItem {
  label: string;
  amount: number; // CZK per month
}

export const FIXED_COSTS_MONTHLY: FixedCostItem[] = [
  { label: "Electricity & Utilities", amount: 8_000 },
  { label: "Software", amount: 2_500 },
];

export const TOTAL_FIXED_COSTS_MONTHLY = FIXED_COSTS_MONTHLY.reduce(
  (sum, c) => sum + c.amount,
  0
);
