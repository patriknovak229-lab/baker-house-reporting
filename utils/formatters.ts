/** Format ISO date string as DD/MM/YYYY */
export function formatDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  return `${day}/${month}/${year}`;
}

/** Format number as EUR currency string */
export function formatCurrency(amount: number): string {
  return `€${amount.toFixed(2)}`;
}
