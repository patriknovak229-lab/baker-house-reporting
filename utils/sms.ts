/**
 * Outbound SMS via Twilio's REST API (called over fetch — no SDK dependency,
 * same lightweight approach the app uses for Beds24 / Telegram).
 *
 * Sender resolution:
 *   - TWILIO_MESSAGING_SERVICE_SID (preferred) — a Messaging Service that
 *     holds the "BakerHouse" alphanumeric sender ID and (optionally) a
 *     number pool, so Twilio auto-falls-back to a real number for
 *     destinations that reject alphanumeric senders (US/Canada/etc.).
 *   - TWILIO_SMS_SENDER (fallback) — a raw alphanumeric sender ID or number.
 *
 * Config is read lazily so a missing env var never breaks the build; callers
 * should gate on `smsConfigured()` and surface a clear "not configured" error.
 */

export interface SendSmsResult {
  sid: string;
  status: string;
}

export function smsConfigured(): boolean {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      (process.env.TWILIO_MESSAGING_SERVICE_SID || process.env.TWILIO_SMS_SENDER),
  );
}

export async function sendSms(to: string, body: string): Promise<SendSmsResult> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  const sender = process.env.TWILIO_SMS_SENDER;

  if (!accountSid || !authToken || (!messagingServiceSid && !sender)) {
    throw new Error('SMS is not configured (missing Twilio env vars)');
  }
  if (!body.trim()) throw new Error('Message body is empty');

  const params = new URLSearchParams();
  params.set('To', to);
  if (messagingServiceSid) params.set('MessagingServiceSid', messagingServiceSid);
  else params.set('From', sender!);
  params.set('Body', body);

  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    },
  );

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Twilio error payloads carry a human-readable `message` + `code`.
    const msg = data?.message || `Twilio responded ${res.status}`;
    const code = data?.code ? ` (code ${data.code})` : '';
    throw new Error(`${msg}${code}`);
  }

  return { sid: data.sid, status: data.status };
}

/**
 * Rough SMS segmentation estimate for operator feedback. GSM-7 packs 160
 * chars/segment (153 when concatenated); any non-GSM char forces UCS-2 at
 * 70/67. We don't do exact GSM-7 charset detection — non-ASCII (incl. Czech
 * diacritics) flips to the unicode budget, which is the conservative call.
 */
export function estimateSmsSegments(text: string): { chars: number; segments: number; unicode: boolean } {
  const chars = [...text].length;
  const unicode = /[^\x00-\x7F]/.test(text);
  const single = unicode ? 70 : 160;
  const multi = unicode ? 67 : 153;
  const segments = chars <= single ? 1 : Math.ceil(chars / multi);
  return { chars, segments: Math.max(1, segments), unicode };
}
