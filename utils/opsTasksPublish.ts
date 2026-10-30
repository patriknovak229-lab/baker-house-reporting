/**
 * Ad-hoc operational tasks → the cleaning app.
 *
 * The operator logs these in the drawer's Reservation Management → Operations
 * block ("restock the minibar", "leave a bottle of wine for a repeat guest").
 * They live in the reservation-override `issues[]` array like every other task;
 * this module publishes the CLEANER-FACING ones to a shared Redis key the
 * cleaning app reads.
 *
 * Why a separate key from `baker:reservation-rate-perks`: that map holds one
 * `RatePerks` per reservation with a single `specialTreatment` string. Ad-hoc
 * tasks are a LIST, each with its own timing, and there can be several per
 * stay — it cannot carry them.
 *
 * Only `special` (Room Task — cleaners) is published. `facility` is the same
 * shape but deliberately stays in reporting: the operator handles equipment.
 * `cleaning` / `earlyCheckin` / `lateCheckout` keep reaching cleaning through
 * the paths they always did (the override map and the perk map) — this channel
 * does not duplicate them.
 *
 * Resolved and deleted tasks simply stop being published, so resolving in
 * reporting is how a cleaner's chip disappears. Cleaners are read-only.
 *
 * Two writers, same as the perk map: the bookings sync rewrites the whole map
 * (authoritative), and a drawer save patches one reservation's entry so the
 * cleaner sees it without waiting for a sync.
 *
 * Keyed by the booking the cleaning app sees, not by reservation: on a
 * multi-apartment reservation each apartment is its own Beds24 booking, so a
 * task goes under the apartment the operator picked, or under every apartment
 * when they didn't (see utils/reservationApartments).
 */
import { getRedis } from "@/utils/beds24Reservations";
import { cleaningFeedNumbers, taskTargets } from "@/utils/reservationApartments";
import type { Issue, Reservation } from "@/types/reservation";

type ReservationKey = Pick<Reservation, "reservationNumber" | "apartmentReservationNumbers">;

export const OPS_TASKS_KEY = "baker:reservation-ops-tasks";

/** One ad-hoc instruction as the cleaning app consumes it. */
export interface OpsTask {
  id: string;
  /** Operator's text, verbatim — the cleaning app never rewrites it. */
  text: string;
  /**
   * Which cleaning it belongs to:
   *   "prep"  → the cleaning that readies the room for this guest
   *   "after" → the next cleaning from now to the end of the stay
   * Legacy entries logged before the picker existed have no timing; treated as
   * "prep", which is where a welcome-gift note (the original use) belongs.
   */
  timing: "prep" | "after";
  /** The operator's own anchor date (YYYY-MM-DD). Placement uses `timing`;
   *  this is carried through so the cleaning app can show it. */
  date: string;
}

function isPublishable(i: Issue): boolean {
  return !i.resolved && i.category === "special" && !!i.text?.trim();
}

function toOpsTask(i: Issue): OpsTask {
  return {
    id: i.id,
    text: i.text.trim(),
    timing: i.timing ?? "prep",
    date: i.actionableDate,
  };
}

/** The publishable subset of one reservation's issues. */
export function opsTasksFromIssues(issues: Issue[] | undefined): OpsTask[] {
  return (issues ?? []).filter(isPublishable).map(toOpsTask);
}

/**
 * One reservation's publishable tasks, by the booking number each goes to: the
 * reservation's own on a single apartment, else the picked apartment or all of
 * them.
 */
export function opsTasksByBooking(
  r: ReservationKey,
  issues: Issue[] | undefined,
): Record<string, OpsTask[]> {
  const out: Record<string, OpsTask[]> = {};
  for (const i of issues ?? []) {
    if (!isPublishable(i)) continue;
    for (const target of taskTargets(r, i)) (out[target] ??= []).push(toOpsTask(i));
  }
  return out;
}

/**
 * Build the whole map — the authoritative pass. `reservations` is the set to
 * publish for: the caller leaves out cancelled stays, so their tasks drop out.
 */
export function buildOpsTasksMap(
  overrides: Record<string, { issues?: Issue[] } | undefined>,
  reservations: ReservationKey[],
): Record<string, OpsTask[]> {
  const map: Record<string, OpsTask[]> = {};
  const seen = new Set<string>();
  for (const r of reservations) {
    if (seen.has(r.reservationNumber)) continue;
    seen.add(r.reservationNumber);
    const byBooking = opsTasksByBooking(r, overrides[r.reservationNumber]?.issues);
    for (const [bookingNumber, tasks] of Object.entries(byBooking)) {
      map[bookingNumber] = [...(map[bookingNumber] ?? []), ...tasks];
    }
  }
  return map;
}

/**
 * Patch a single reservation's entries. Called right after the drawer saves,
 * so an instruction reaches the cleaner on their next page load rather than at
 * the next bookings sync. Every apartment is rewritten, so a task re-pointed
 * from "all apartments" to one leaves the others; an empty list removes the
 * entry.
 */
export async function publishOpsTasksEntry(
  r: ReservationKey,
  issues: Issue[] | undefined,
): Promise<Record<string, OpsTask[]>> {
  const byBooking = opsTasksByBooking(r, issues);
  const redis = getRedis();
  if (!redis) return byBooking;
  const map = (await redis.get<Record<string, OpsTask[]>>(OPS_TASKS_KEY)) ?? {};
  for (const bookingNumber of new Set([...cleaningFeedNumbers(r), ...Object.keys(byBooking)])) {
    const tasks = byBooking[bookingNumber];
    if (tasks?.length) map[bookingNumber] = tasks;
    else delete map[bookingNumber];
  }
  await redis.set(OPS_TASKS_KEY, map);
  return byBooking;
}

/** Drop a reservation from the map — cancellations, which the authoritative
 *  pass skips and would otherwise leave behind. */
export async function removeOpsTasksEntry(r: ReservationKey): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const map = (await redis.get<Record<string, OpsTask[]>>(OPS_TASKS_KEY)) ?? {};
  const present = cleaningFeedNumbers(r).filter((n) => n in map);
  if (present.length === 0) return;
  for (const n of present) delete map[n];
  await redis.set(OPS_TASKS_KEY, map);
}
