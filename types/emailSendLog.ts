/** Single record of a guest-facing templated message that was sent.
 *  Persisted in Redis under baker:email-send-log keyed by reservationNumber
 *  so the operator sees template + timestamp under the "Email Guest" /
 *  "WhatsApp Guest" pills. */
export interface EmailSendLogEntry {
  /** Unique id (timestamp + random) so multiple sends in the same second don't collide. */
  id: string;
  reservationNumber: string;
  /** Stable template id (e.g. "thank-you"). */
  templateId: string;
  /** Human-readable label shown in the drawer (e.g. "Thank You"). */
  templateLabel: string;
  /**
   * Channel the message went out on. Optional for backward-compatibility
   * with log entries written before the WhatsApp channel existed —
   * undefined is treated as 'email'.
   */
  channel?: 'email' | 'whatsapp' | 'sms';
  /** Address/phone the message was delivered to.
   *  - email channel: email address
   *  - whatsapp channel: E.164-ish phone digits (no leading +)
   *  - sms channel: E.164 phone number (with leading +) */
  to: string;
  /** Email subject — empty string for WhatsApp/SMS (no subject line). */
  subject: string;
  /** ISO timestamp of the successful send. */
  sentAt: string;
  /** Operator email captured from the auth session. */
  sentBy: string;
}
