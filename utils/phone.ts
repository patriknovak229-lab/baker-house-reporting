/**
 * Best-effort phone normalization to E.164 (e.g. "+420737123456").
 *
 * Guest phone numbers come from Beds24/OTAs in every conceivable format —
 * with/without "+", with "00" international prefix, spaces, dashes,
 * parentheses, or as a bare national number. SMS (Twilio) requires E.164.
 *
 * Rules (defaultDialCode defaults to Czech "420"):
 *   - leading "+"            → trust it (strip junk, keep digits)
 *   - leading "00"           → international prefix → "+" + rest
 *   - exactly 9 digits       → assume a local CZ mobile → "+420" + digits
 *   - 11–15 digits           → assume country code already present → "+" + digits
 *   - anything shorter than 8 digits → unsendable → null
 *
 * The 9-digit→CZ assumption is right for this property's typical guests;
 * anything ambiguous still gets a "+", and the operator sees the resolved
 * number in the modal before sending (and Twilio rejects truly bad ones),
 * so a wrong guess is visible and recoverable rather than silent.
 */
export function toE164(raw: string | null | undefined, defaultDialCode = '420'): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Leading "+" — keep the digits after it.
  if (trimmed.startsWith('+')) {
    const digits = trimmed.slice(1).replace(/\D/g, '');
    return digits.length >= 8 ? `+${digits}` : null;
  }

  // "00" international access code → "+".
  if (trimmed.startsWith('00')) {
    const digits = trimmed.slice(2).replace(/\D/g, '');
    return digits.length >= 8 ? `+${digits}` : null;
  }

  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 8) return null;

  // Already includes the default country's dial code (e.g. "420737…").
  if (digits.startsWith(defaultDialCode) && digits.length >= defaultDialCode.length + 8) {
    return `+${digits}`;
  }

  // Bare national mobile (CZ mobiles are 9 digits, no trunk prefix).
  if (digits.length === 9) {
    return `+${defaultDialCode}${digits}`;
  }

  // 11–15 digits with no "+" → assume the country code is already there.
  if (digits.length >= 11 && digits.length <= 15) {
    return `+${digits}`;
  }

  // 10 digits is ambiguous — best guess is that it's international.
  if (digits.length === 10) {
    return `+${digits}`;
  }

  return null;
}
