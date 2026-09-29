/**
 * Check-in / check-out restrictions: Beds24's per-day calendar `override`
 * values `noCheckIn`, `noCheckOut` and `noCheckInOrCheckOut`.
 *
 * Unlike a blackout, a restriction never closes a night. A stay can always pass
 * THROUGH a restricted day: `noCheckOut` only stops a stay ending on it (the
 * cleaners-off case: no departure, nothing to clean), `noCheckIn` only stops one
 * starting on it. Existing bookings are untouched either way.
 *
 * WHERE IT HAS TO BE WRITTEN is the part that is easy to get wrong. Beds24
 * evaluates restrictions on the room that is SOLD, and Booking.com, Airbnb and
 * the website sell the two studio types as virtual rooms (Urban 679714, Deluxe
 * 1KK 648816), not as the physical units behind them. Verified 2026-09-29 against
 * live offers with the min-stay equivalent: the Deluxe 1KK virtual room sold a
 * 1-night stay on a date where its only free unit (K.202) required 2 nights, and
 * refused one where the virtual room required 2 but K.203 allowed 1. So a
 * restriction on K.202 alone restricts nothing that is for sale. Blackouts are
 * the opposite case: they remove a unit's availability, which the virtual room
 * does inherit. That is why BlackoutModal targets physical rooms and this does not.
 *
 * PriceLabs does not write these values today; it pushes price1 + minStay. It does
 * support check-in/check-out restrictions for Beds24, though, so if that feature
 * is ever switched on in PriceLabs it will start owning this field. Keep it off.
 *
 * Client-safe: no server imports.
 */

export type RestrictionKind = 'noCheckIn' | 'noCheckOut' | 'noCheckInOrCheckOut';

export const RESTRICTION_KINDS: readonly RestrictionKind[] = [
  'noCheckIn',
  'noCheckOut',
  'noCheckInOrCheckOut',
];

export const RESTRICTION_LABEL: Record<RestrictionKind, string> = {
  noCheckIn: 'No check-in',
  noCheckOut: 'No check-out',
  noCheckInOrCheckOut: 'No check-in or check-out',
};

/** Fits a single ~30 px calendar cell. */
export const RESTRICTION_SHORT: Record<RestrictionKind, string> = {
  noCheckIn: 'no in',
  noCheckOut: 'no out',
  noCheckInOrCheckOut: 'no i/o',
};

export function isRestrictionKind(value: unknown): value is RestrictionKind {
  return typeof value === 'string' && (RESTRICTION_KINDS as readonly string[]).includes(value);
}

// ─── Sellable units ──────────────────────────────────────────────────────────

export type SellableUnitKey = 'urban' | 'deluxe1kk' | 'k201' | 'o308';

export interface SellableUnit {
  key: SellableUnitKey;
  label: string;
  /** The Beds24 room the channels and the website sell. Restrictions go here. */
  roomId: number;
  /** Physical units behind it, i.e. the calendar rows a restriction is drawn on. */
  units: { label: string; roomId: number }[];
}

export const SELLABLE_UNITS: readonly SellableUnit[] = [
  {
    key: 'urban',
    label: 'Urban studios',
    roomId: 679714,
    units: [
      { label: 'K.102', roomId: 679703 },
      { label: 'K.103', roomId: 679704 },
      { label: 'K.106', roomId: 679705 },
    ],
  },
  {
    key: 'deluxe1kk',
    label: 'Deluxe 1KK',
    roomId: 648816,
    units: [
      { label: 'K.202', roomId: 648596 },
      { label: 'K.203', roomId: 648772 },
    ],
  },
  { key: 'k201', label: 'K.201', roomId: 656437, units: [{ label: 'K.201', roomId: 656437 }] },
  { key: 'o308', label: 'O.308', roomId: 674672, units: [{ label: 'O.308', roomId: 674672 }] },
];

/** The unit a Beds24 room belongs to, whether it is the sold room or one of its physical units. */
export function unitForRoomId(roomId: number): SellableUnit | null {
  return (
    SELLABLE_UNITS.find((u) => u.roomId === roomId || u.units.some((p) => p.roomId === roomId)) ??
    null
  );
}

/**
 * Every Beds24 room whose restrictions we read: the four sold rooms plus the
 * physical units behind the two virtual ones. A restriction on one of those units
 * does nothing, but Beds24's calendar invites setting it there, so it is shown
 * (flagged) rather than silently ignored.
 */
export const RESTRICTION_ROOM_IDS: readonly number[] = [
  ...new Set(SELLABLE_UNITS.flatMap((u) => [u.roomId, ...u.units.map((p) => p.roomId)])),
];

// ─── Restriction records ─────────────────────────────────────────────────────

export interface StayRestriction {
  /** `RS-<roomId>-<kind>-<from>-<to>`, which is everything DELETE needs. */
  id: string;
  /** Beds24 room carrying the override. */
  roomId: number;
  unitKey: SellableUnitKey;
  unitLabel: string;
  /** Calendar rows (physical rooms) it is drawn on. */
  rooms: string[];
  kind: RestrictionKind;
  /** First and last restricted DAY, both inclusive (Beds24's calendar convention). */
  from: string;
  to: string;
  /** False when it sits on one physical unit of a virtual room, where it restricts no sale. */
  effective: boolean;
}

export function restrictionId(roomId: number, kind: RestrictionKind, from: string, to: string): string {
  return `RS-${roomId}-${kind}-${from}-${to}`;
}

export function parseRestrictionId(
  id: string,
): { roomId: number; kind: RestrictionKind; from: string; to: string } | null {
  const m = /^RS-(\d+)-([A-Za-z]+)-(\d{4}-\d{2}-\d{2})-(\d{4}-\d{2}-\d{2})$/.exec(id);
  if (!m || !isRestrictionKind(m[2]) || m[4] < m[3]) return null;
  return { roomId: Number(m[1]), kind: m[2], from: m[3], to: m[4] };
}

// ─── Day arithmetic (UTC on plain YYYY-MM-DD strings) ────────────────────────

export function isYmd(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

export function addDays(ymd: string, days: number): string {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Every day from..to, both included. Empty when to < from. */
export function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  return days;
}

// ─── Reading Beds24's calendar ───────────────────────────────────────────────

/** A calendar entry as returned with `includeOverride=true`: per day, or a from/to range. */
export interface CalendarOverrideEntry {
  from?: string;
  to?: string;
  override?: string | null;
}

/** Expand calendar entries into one override value per day ('none' when unset). */
export function overrideByDay(entries: CalendarOverrideEntry[]): Record<string, string> {
  const byDay: Record<string, string> = {};
  for (const e of entries) {
    if (!isYmd(e.from)) continue;
    const to = isYmd(e.to) ? e.to : e.from;
    for (const day of eachDay(e.from, to)) byDay[day] = e.override || 'none';
  }
  return byDay;
}

/** Consecutive days carrying the same restriction, coalesced into runs. */
export function restrictionRuns(
  byDay: Record<string, string>,
): { kind: RestrictionKind; from: string; to: string }[] {
  const runs: { kind: RestrictionKind; from: string; to: string }[] = [];
  for (const day of Object.keys(byDay).sort()) {
    const kind = byDay[day];
    if (!isRestrictionKind(kind)) continue;
    const last = runs[runs.length - 1];
    if (last && last.kind === kind && addDays(last.to, 1) === day) last.to = day;
    else runs.push({ kind, from: day, to: day });
  }
  return runs;
}

/** Displayable restrictions for one Beds24 room. Rooms outside the property map yield none. */
export function restrictionsForRoom(roomId: number, byDay: Record<string, string>): StayRestriction[] {
  const unit = unitForRoomId(roomId);
  if (!unit) return [];
  const sold = unit.roomId === roomId;
  const rooms = sold
    ? unit.units.map((p) => p.label)
    : unit.units.filter((p) => p.roomId === roomId).map((p) => p.label);
  return restrictionRuns(byDay).map((run) => ({
    id: restrictionId(roomId, run.kind, run.from, run.to),
    roomId,
    unitKey: unit.key,
    unitLabel: unit.label,
    rooms,
    kind: run.kind,
    from: run.from,
    to: run.to,
    effective: sold,
  }));
}

// ─── Planning writes ─────────────────────────────────────────────────────────

/** Both restrictions on the same day: a restriction is only ever added to, never weakened. */
export function combineKinds(existing: RestrictionKind | null, requested: RestrictionKind): RestrictionKind {
  if (!existing || existing === requested) return requested;
  return 'noCheckInOrCheckOut';
}

export interface RestrictionWritePlan {
  /** Ranges to POST. Empty whenever there are conflicts. */
  writes: { from: string; to: string; override: RestrictionKind }[];
  /** Days holding a blackout or exception. A day has ONE override, so writing would replace it. */
  conflicts: { date: string; override: string }[];
  /** Days where a different existing restriction was combined with the requested one. */
  merged: string[];
  /** Days that already carried the requested restriction (or stricter). */
  unchanged: string[];
}

/**
 * What to write so that every day from..to carries `kind`, given the room's
 * current overrides. A blackout or exception day is a conflict: overwriting a
 * blackout would re-open the room for sale, so nothing is written at all.
 */
export function planRestrictionWrite(
  byDay: Record<string, string>,
  from: string,
  to: string,
  kind: RestrictionKind,
): RestrictionWritePlan {
  const plan: RestrictionWritePlan = { writes: [], conflicts: [], merged: [], unchanged: [] };
  for (const day of eachDay(from, to)) {
    const current = byDay[day] || 'none';
    if (current === 'blackout' || current === 'exception') {
      plan.conflicts.push({ date: day, override: current });
      continue;
    }
    const existing = isRestrictionKind(current) ? current : null;
    const target = combineKinds(existing, kind);
    if (existing === target) {
      plan.unchanged.push(day);
      continue;
    }
    if (existing) plan.merged.push(day);
    const last = plan.writes[plan.writes.length - 1];
    if (last && last.override === target && addDays(last.to, 1) === day) last.to = day;
    else plan.writes.push({ from: day, to: day, override: target });
  }
  if (plan.conflicts.length > 0) plan.writes = [];
  return plan;
}

/**
 * Ranges to reset to 'none' when removing a displayed restriction. Only days that
 * still carry exactly `kind` are cleared, so anything changed since the calendar
 * was read (a blackout, a different restriction) is left alone.
 */
export function planRestrictionClear(
  byDay: Record<string, string>,
  from: string,
  to: string,
  kind: RestrictionKind,
): { from: string; to: string }[] {
  const ranges: { from: string; to: string }[] = [];
  for (const day of eachDay(from, to)) {
    if (byDay[day] !== kind) continue;
    const last = ranges[ranges.length - 1];
    if (last && addDays(last.to, 1) === day) last.to = day;
    else ranges.push({ from: day, to: day });
  }
  return ranges;
}
