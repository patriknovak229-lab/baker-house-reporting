/**
 * Operator "this is OK" confirmations for VAT flags.
 *
 * A confirmed flag stays visible (collapsed, greyed) but no longer counts as
 * a warning. Errors can't be confirmed — they must be fixed before filing.
 */
import { createHash } from 'node:crypto';
import type { VatAcknowledgement, VatFlag } from '@/types/vat';

/**
 * The settings key a confirmation is stored under. It decides when a
 * confirmation goes stale: if the key of a flag changes (e.g. a new item
 * appears under it), the flag comes back as an open warning.
 */
export function flagAckKey(flag: VatFlag): string {
  // Title covers item-less flags (e.g. the threshold month); sorted item labels
  // make a NEW supplier / booking re-open the warning. Amounts are left out so
  // fixing a typo doesn't undo the confirmation.
  const labels = (flag.items ?? []).map((i) => i.label).sort();
  const fingerprint = createHash('sha1').update(JSON.stringify([flag.title, labels])).digest('hex').slice(0, 16);
  return `ack:${flag.code}:${fingerprint}`;
}

export function applyAcknowledgements(flags: VatFlag[], acknowledged: Record<string, VatAcknowledgement>): void {
  for (const f of flags) {
    if (f.severity === 'error') continue;
    f.ackKey = flagAckKey(f);
    const ack = acknowledged[f.ackKey];
    if (ack) f.acknowledged = ack;
  }
  // Confirmed flags sink below the open ones (stable sort keeps severity order).
  flags.sort((a, b) => Number(!!a.acknowledged) - Number(!!b.acknowledged));
}
