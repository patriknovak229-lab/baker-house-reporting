/** Format ISO date string as DD/MM/YYYY */
export function formatDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  return `${day}/${month}/${year}`;
}

/** Format number as CZK currency string, rounded to whole crowns.
 *  The dashboard default — figures there are read at a glance, not reconciled. */
export function formatCurrency(amount: number): string {
  return `${Math.round(amount).toLocaleString("cs-CZ")} Kč`;
}

/**
 * Format number as CZK to the haléř: `3 687,67 Kč`.
 *
 * For documents that leave the building — invoices above all. A guest's
 * accounting team matches the invoice against the line on their bank or card
 * statement, and a figure rounded to whole crowns never matches: 3 687,67 Kč
 * charged against 3 688 Kč invoiced is a discrepancy they have to chase.
 *
 * Deliberately separate from formatCurrency rather than replacing it — that one
 * is used in 25 files of dashboard and analytics, where two decimals on every
 * figure would be noise.
 */
export function formatCurrencyExact(amount: number): string {
  return `${amount.toLocaleString("cs-CZ", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} Kč`;
}

/**
 * Format amount with explicit currency.
 * For CZK (or no currency), falls back to formatCurrency.
 * For other currencies uses Intl with 2 decimal places.
 */
export function formatAmount(amount: number, currency?: string | null): string {
  if (!currency || currency === 'CZK') return formatCurrency(amount);
  return amount.toLocaleString('cs-CZ', { style: 'currency', currency, maximumFractionDigits: 2 });
}
