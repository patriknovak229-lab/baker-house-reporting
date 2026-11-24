// Shared Telegram sender for operator alerts (Baker House Operations group).
//
// The app has several inline copies of this in individual route handlers; new
// code should import from here. IMPORTANT: always `await sendTelegram(...)` —
// never fire-and-forget from a serverless handler, or Vercel may kill the
// function before api.telegram.org responds and the message is lost.
//
// No-ops (returns false) when TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are unset.

export async function sendTelegram(
  message: string,
  opts?: { chatId?: string },
): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = opts?.chatId ?? process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.error("[telegram] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set");
    return false;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      console.error("[telegram] send failed:", await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error("[telegram] send error:", err);
    return false;
  }
}

/** Escape the HTML entities Telegram's HTML parse_mode cares about. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
/**
 * "👤 First Last" line for booking alerts, escaped. A raw `&` or `<` in a guest
 * name makes Telegram reject the whole message (400 "can't parse entities"),
 * and the booking's dedupe key is already set by then, so the alert is lost.
 */
export function guestNameLine(firstName?: string | null, lastName?: string | null): string {
  const name = `${firstName ?? ""} ${lastName ?? ""}`.trim();
  return `👤 ${name ? escapeHtml(name) : "—"}`;
}

/**
 * Destination for PRICING alerts (parity violations, radar digest). Falls back
 * to the ops group until TELEGRAM_PRICING_CHAT_ID is set — the operator wants
 * pricing noise out of the shared Baker House Operations group, so this should
 * point at a DM with the bot or a dedicated pricing group.
 */
export function pricingChatId(): string | undefined {
  return process.env.TELEGRAM_PRICING_CHAT_ID ?? process.env.TELEGRAM_CHAT_ID;
}

/**
 * Destination for invoice "needs a manual send" alerts (guest asked for a
 * different amount, or the checkout is beyond the auto-send window). The
 * operator asked (2026-10-08) for these to land where the price-parity results
 * go, so the shared Baker House Operations group isn't spammed. Deliberately
 * the SAME chat as pricing: move one, the other follows.
 */
export function invoiceAlertChatId(): string | undefined {
  return pricingChatId();
}

/**
 * Destination for TECHNICAL alerts — the system reporting on itself: the cron
 * watchdog and daily catch-up, scheduled jobs that crashed or failed, health
 * checks. Operator request (2026-11-08): these go to the technical chat where
 * price parity lands, not the Baker House Operations group, which is for
 * things someone has to do about a guest or a booking. Same chat as pricing
 * on purpose: move one, the others follow.
 */
export function technicalChatId(): string | undefined {
  return pricingChatId();
}

/**
 * `sendTelegram` to the technical chat (see technicalChatId). Never throws.
 *
 * When Telegram does not deliver it (bot token revoked, bot removed from the
 * chat, Telegram down, a message it refuses to parse) the alert goes out by
 * email instead (utils/alertEmail) — otherwise a broken bot would silence every
 * alert without a trace. Deployments only, so local runs never email. True when
 * either channel delivered.
 */
export async function sendTechnicalAlert(message: string): Promise<boolean> {
  if (await sendTelegram(message, { chatId: technicalChatId() })) return true;
  if (!process.env.VERCEL) return false;
  const { sendAlertEmail } = await import("./alertEmail");
  return sendAlertEmail(
    "Baker House: technical alert (Telegram did not deliver it)",
    `${message}\n\n<i>Sent by email because Telegram refused or could not be reached — see "[telegram]" in the Vercel logs.</i>`,
  );
}

/**
 * Can the bot still post to the technical chat? `getChat` fails for a revoked
 * token AND for a bot removed from the chat — the two ways alerts stop silently.
 */
export async function checkTechnicalChat(): Promise<{ ok: boolean; reason?: string }> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = technicalChatId();
  if (!token || !chatId) return { ok: false, reason: "TELEGRAM_BOT_TOKEN or the chat id is not set" };
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/getChat?chat_id=${encodeURIComponent(chatId)}`,
      { cache: "no-store" },
    );
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => null)) as { description?: string } | null;
    return { ok: false, reason: `HTTP ${res.status}${body?.description ? `: ${body.description}` : ""}` };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
