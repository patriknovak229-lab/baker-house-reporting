/** Format ISO date string as DD/MM/YYYY */
export function formatDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  return `${day}/${month}/${year}`;
}

/** Format number as CZK currency string */
export function formatCurrency(amount: number): string {
  return `${Math.round(amount).toLocaleString("cs-CZ")} Kč`;
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
