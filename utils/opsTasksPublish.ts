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
 */
import { getRedis } from "@/utils/beds24Reservations";
import type { Issue } from "@/types/reservation";

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

/** The publishable subset of one reservation's issues. */
export function opsTasksFromIssues(issues: Issue[] | undefined): OpsTask[] {
  if (!issues?.length) return [];
  return issues
    .filter((i) => !i.resolved && i.category === "special" && i.text?.trim())
    .map((i) => ({
      id: i.id,
      text: i.text.trim(),
      timing: i.timing ?? "prep",
      date: i.actionableDate,
    }));
}

/** Build the whole map from the override overlay — the authoritative pass. */
export function buildOpsTasksMap(
  overrides: Record<string, { issues?: Issue[] } | undefined>,
  isPublishable: (reservationNumber: string) => boolean,
): Record<string, OpsTask[]> {
  const map: Record<string, OpsTask[]> = {};
  for (const [reservationNumber, entry] of Object.entries(overrides)) {
    if (!isPublishable(reservationNumber)) continue;
    const tasks = opsTasksFromIssues(entry?.issues);
    if (tasks.length > 0) map[reservationNumber] = tasks;
  }
  return map;
}

/**
 * Patch a single reservation's entry. Called right after the drawer saves, so
 * an instruction reaches the cleaner on their next page load rather than at the
 * next bookings sync. An empty list removes the entry.
 */
export async function publishOpsTasksEntry(
  reservationNumber: string,
  issues: Issue[] | undefined,
): Promise<OpsTask[]> {
  const tasks = opsTasksFromIssues(issues);
  const redis = getRedis();
  if (!redis) return tasks;
  const map = (await redis.get<Record<string, OpsTask[]>>(OPS_TASKS_KEY)) ?? {};
  if (tasks.length > 0) map[reservationNumber] = tasks;
  else delete map[reservationNumber];
  await redis.set(OPS_TASKS_KEY, map);
  return tasks;
}

/** Drop a reservation from the map — cancellations, which the authoritative
 *  pass skips and would otherwise leave behind. */
export async function removeOpsTasksEntry(reservationNumber: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const map = (await redis.get<Record<string, OpsTask[]>>(OPS_TASKS_KEY)) ?? {};
  if (!(reservationNumber in map)) return;
  delete map[reservationNumber];
  await redis.set(OPS_TASKS_KEY, map);
}
