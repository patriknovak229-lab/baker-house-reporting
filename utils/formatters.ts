/** Format ISO date string as DD/MM/YYYY */
export function formatDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  return `${day}/${month}/${year}`;
}

/** Format number as CZK currency string */
export function formatCurrency(amount: number): string {
  return `${Math.round(amount).toLocaleString("cs-CZ")} Kč`;
}
