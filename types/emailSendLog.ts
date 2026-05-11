/** Single record of a guest-facing template email that was sent. Persisted
 *  in Redis under baker:email-send-log keyed by reservationNumber so the
 *  operator can see template + timestamp under the "Email Guest" pill. */
export interface EmailSendLogEntry {
  /** Unique id (timestamp + random) so multiple sends in the same second don't collide. */
  id: string;
  reservationNumber: string;
  /** Stable template id (e.g. "thank-you"). */
  templateId: string;
  /** Human-readable label shown in the drawer (e.g. "Thank You"). */
  templateLabel: string;
  /** Address the email was delivered to. */
  to: string;
  subject: string;
  /** ISO timestamp of the successful send. */
  sentAt: string;
  /** Operator email captured from the auth session. */
  sentBy: string;
}
