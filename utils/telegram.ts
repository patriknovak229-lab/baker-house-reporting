// Shared Telegram sender for operator alerts (Baker House Operations group).
//
// The app has several inline copies of this in individual route handlers; new
// code should import from here. IMPORTANT: always `await sendTelegram(...)` —
// never fire-and-forget from a serverless handler, or Vercel may kill the
// function before api.telegram.org responds and the message is lost.
//
// No-ops (returns false) when TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are unset.

export async function sendTelegram(message: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
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
