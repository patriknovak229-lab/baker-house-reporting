import { withWebhookSecret } from '@/utils/webhookSecret';

/**
 * Lazy auto-reply nudge — POST a SYNC_ROOM to our own Beds24 webhook so the
 * auto-reply pipeline runs. Beds24's Inventory Webhook doesn't fire on guest
 * messages, so the drawer and the unread-messages poll call this instead. The
 * webhook applies its own 15s debounce, so this is cheap to call repeatedly.
 * The roomId/propId values are placeholders (the webhook polls Beds24 for
 * unread messages property-wide).
 *
 * Callers run it inside `after()`: a bare fire-and-forget promise can be cut
 * off when the response returns on Vercel. It carries WEBHOOK_SECRET, and
 * logs a non-2xx answer — fetch doesn't throw on 401, so a missing secret
 * would otherwise stop every nudge without a trace.
 */
export async function triggerAutoReplyPoll(): Promise<void> {
  const baseUrl =
    process.env.NEXT_PUBLIC_BASE_URL?.trim() ||
    'https://reporting.bakerhouseapartments.cz';
  const res = await fetch(withWebhookSecret(`${baseUrl}/api/webhook/beds24-message`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      roomId: '0',
      propId: '311322',
      ownerId: '0',
      action: 'SYNC_ROOM',
    }),
    cache: 'no-store',
  });
  if (!res.ok) {
    console.warn(`[auto-reply nudge] webhook answered ${res.status}`);
  }
}
