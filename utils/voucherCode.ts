// Shared voucher-code builders used by both CreateVoucherModal and the
// embedded voucher flow inside EmailGuestModal. Keep the logic identical so
// codes look the same regardless of where they were generated.

/** Strip all non-alphanumeric characters. */
export function sanitizeCode(s: string): string {
  return s.replace(/[^a-zA-Z0-9]/g, '');
}

/** 4 random hex chars (e.g. "A3F9") — 65,536 combinations. */
export function generateSuffix(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 4).toUpperCase();
}

/** Build a voucher code with the standard shape "{Prefix}-{amount}-{suffix}".
 *  - With name (linked or named standalone):  "Tamara-1000-A3F9"
 *  - Without name (unlinked):                 "BAKER-1000-A3F9" */
export function generateCode(firstName: string, value: string | number, suffix: string): string {
  const name = sanitizeCode(String(firstName)).replace(/\s+/g, '');
  const val = sanitizeCode(String(value));
  if (!val) return '';
  const prefix = name
    ? name.charAt(0).toUpperCase() + name.slice(1).toLowerCase()
    : 'BAKER';
  return `${prefix}-${val}-${suffix}`;
}
