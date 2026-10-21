/**
 * Turnover cleanings a confirmed stay link makes unnecessary.
 *
 * When the operator links a prolongation to the stay it continues
 * (`stayLink` on the later booking — utils/stayChains.ts), the earlier
 * booking's checkout is no longer a turnover: the same guest stays on in the
 * same unit. The cleaning app hides that cleaning, and the cost engine must
 * not bill it or expect it. This replaces removing it by hand
 * ("Prodloužený pobyt").
 *
 * ⚠️ The cleaning app applies the SAME rule to the same inputs (its schedule
 * snapshot + public.reservation_overrides) in
 * baker-house-cleaning/src/lib/stayContinuations.ts. Keep the two identical,
 * or the dashboard and the cleaners' schedule disagree about which cleanings
 * exist.
 *
 * Rules:
 *   - only operator-confirmed links count — names are never guessed here;
 *   - matched by booking ids, not date|room: the checkout task of booking A
 *     is skipped when a task in the SAME room belongs to a booking B whose
 *     `stayLink.prev` is A and which arrives on A's checkout day;
 *   - a different apartment means the guest moved — that cleaning stays;
 *   - a link only hides cleanings dated on or after the day it was made
 *     (Prague time): linking a pair after the handover never rewrites a
 *     cleaning that already happened, or the cost it carried.
 *
 * Pure.
 */

/** The snapshot task fields the rule reads (`baker:beds24-schedule-snapshot`). */
export interface ScheduleTaskRef {
  id: string;
  bookId: string | number;
  roomId: string | number;
  date: string;
  arrival?: string;
  departure?: string;
}

export interface StayLinkOverrideRef {
  stayLink?: { prev?: string; linkedAt?: string } | null;
}

/** Ids of the vacated-unit cleanings of mid-stay moves — never a checkout. */
const MOVE_TASK_PREFIX = "move-";

/** Calendar date in Prague for an ISO timestamp (YYYY-MM-DD). */
export function pragueDateOf(iso: string): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleDateString("sv-SE", { timeZone: "Europe/Prague" });
}

/** Ids of the checkout tasks that a confirmed stay link turns into a continuing stay. */
export function stayContinuedTaskIds(
  tasks: readonly ScheduleTaskRef[],
  overrides: Record<string, StayLinkOverrideRef | undefined> | null | undefined,
): Set<string> {
  const out = new Set<string>();
  if (!overrides) return out;

  // A → { roomId, arrival, link day } of the booking that continues A.
  const continuations = new Map<string, { roomId: string; arrival: string; linkedOn: string }[]>();
  for (const u of tasks) {
    if (u.id.startsWith(MOVE_TASK_PREFIX) || !u.arrival) continue;
    const link = overrides[`BH-${u.bookId}`]?.stayLink;
    if (!link?.prev || !link.linkedAt) continue;
    const linkedOn = pragueDateOf(link.linkedAt);
    if (!linkedOn) continue;
    const list = continuations.get(link.prev) ?? [];
    list.push({ roomId: String(u.roomId), arrival: u.arrival, linkedOn });
    continuations.set(link.prev, list);
  }
  if (continuations.size === 0) return out;

  for (const t of tasks) {
    if (t.id.startsWith(MOVE_TASK_PREFIX)) continue;
    const checkout = t.departure ?? t.date;
    if (t.date !== checkout) continue; // only the checkout-day turnover itself
    const next = continuations.get(`BH-${t.bookId}`);
    if (!next) continue;
    if (next.some((n) => n.roomId === String(t.roomId) && n.arrival === checkout && n.linkedOn <= t.date)) {
      out.add(t.id);
    }
  }
  return out;
}

/** The same cleanings as `date|roomId` keys — how cost and assignment data is keyed. */
export function stayContinuedCleaningKeys(
  tasks: readonly ScheduleTaskRef[],
  overrides: Record<string, StayLinkOverrideRef | undefined> | null | undefined,
): Set<string> {
  const ids = stayContinuedTaskIds(tasks, overrides);
  const keys = new Set<string>();
  for (const t of tasks) if (ids.has(t.id)) keys.add(`${t.date}|${t.roomId}`);
  return keys;
}
