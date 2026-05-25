/**
 * Reply templates for the multi-turn invoice request flow. Separate file
 * from `messageAutoReplyTemplates.ts` because the invoice flow has its
 * own shape (variable missing-field list, dynamic checkout date) and
 * its own translation needs.
 *
 * All templates authored in English with {PLACEHOLDERS}, translated to
 * the guest's detected language via utils/googleTranslate.ts, then
 * placeholders substituted AFTER translation so literal values
 * (company name, email address, ICO digits, dates) stay untouched.
 * Sign-off "— Zuzana" appended after substitution.
 */

import { translateText } from '@/utils/googleTranslate';
import { applyGreeting } from '@/utils/greeting';

const SIGN_OFF = '\n\n— Zuzana';

export type InvoiceMandatory = 'companyName' | 'ico' | 'email';

/**
 * Ask the guest for missing mandatory fields. The list is built dynamically
 * from `missing` so we never ask for something we already have. Email
 * always carries the generic "we are not getting the email" note per
 * operator instruction — no channel-specific wording.
 */
export async function renderMissingFieldsReply(
  firstName: string,
  missing: InvoiceMandatory[],
  language: string,
): Promise<string> {
  const bullets = missing.map((f) => `• ${labelForField(f)}`).join('\n');

  // Build EN template — the guest's name goes in inline before
  // translation so it flows naturally in the translated sentence.
  const safeName = firstName || 'there';
  const template =
    `{{GREETING}} ${safeName}! Thank you for the invoice request. To prepare it we still need:\n\n` +
    `{BULLETS}\n\n` +
    `Please reply with these in one message and we'll take care of the rest.`;

  let body = template.replace('{BULLETS}', bullets);
  body = await translateIfNeeded(body, language);
  body = applyGreeting(body, language);
  return body + SIGN_OFF;
}

/**
 * Confirm to the guest that we have what we need and the invoice will go
 * out after their checkout. The email + date are substituted AFTER
 * translation so they're never mangled.
 */
export async function renderInvoiceConfirmation(
  firstName: string,
  email: string,
  checkoutDate: string,
  language: string,
): Promise<string> {
  const safeName = firstName || 'there';
  // Pre-translation template — name inlined, email and date kept as tokens
  const template =
    `{{GREETING}} ${safeName}! Thank you, we have everything we need. The invoice will be sent to {EMAIL} after your checkout on {DATE}.`;

  let body = await translateIfNeeded(template, language);
  body = body
    .replace(/\{EMAIL\}/g, email)
    .replace(/\{DATE\}/g, formatDate(checkoutDate, language));
  body = applyGreeting(body, language);
  return body + SIGN_OFF;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function labelForField(field: InvoiceMandatory): string {
  // EN labels — translated together with the rest of the message via
  // translateIfNeeded. Phrased deliberately so machine translation
  // produces natural Czech/Slovak/German output.
  switch (field) {
    case 'companyName':
      return 'Company name';
    case 'ico':
      return 'Company ID (IČO)';
    case 'email':
      // Per operator instruction: generic phrasing, no channel name
      return 'Your email address (we are not getting it from the booking)';
  }
}

async function translateIfNeeded(text: string, language: string): Promise<string> {
  const lang = (language || '').toLowerCase();
  if (!lang || lang === 'en') return text;
  try {
    const result = await translateText(text, lang);
    return result?.translatedText ?? text;
  } catch (err) {
    console.warn(
      '[invoiceReplyTemplates] translation failed, falling back to EN:',
      err instanceof Error ? err.message : err,
    );
    return text;
  }
}

function formatDate(yyyymmdd: string, language: string): string {
  if (!yyyymmdd) return '';
  const d = new Date(yyyymmdd + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return yyyymmdd;
  const locale = language.toLowerCase() === 'cs' ? 'cs-CZ' : 'en-GB';
  return d.toLocaleDateString(locale, { day: '2-digit', month: 'short', year: 'numeric' });
}
