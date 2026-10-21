/**
 * Stay links — one guest's stay booked as several back-to-back reservations.
 *
 * The usual shape: a guest on a Booking.com / Airbnb booking asks for another
 * night, and we sell it as a separate direct booking. Beds24 sees two
 * unrelated reservations; the guest sees one stay. Early arrivals are the
 * mirror image (the extra booking comes first). Sometimes it is several
 * bookings in a row (BH-87127096 → BH-87335189 → BH-87574083 → BH-88107336).
 *
 * The link is an operator decision, stored on the LATER booking by dates as
 * `stayLink.prev` in the reservation overrides (see `StayLink`). This module:
 *   - resolves confirmed links into stays (`stayChains`, `stayChainIndex`),
 *     ignoring any link whose two bookings no longer meet;
 *   - lists likely-but-unconfirmed pairs for the operator (`staySuggestions`);
 *   - gives the room resolver its "same stay" identity (`sameStayKeys`).
 *
 * Only CONFIRMED links may drive anything that would hurt if wrong — the
 * cleaning app skipping the turnover clean between two bookings is the
 * example: guessing wrong sends a guest into an uncleaned room. Name matching
 * is only good enough for suggestions and for the room resolver, where
 * over-matching merely moves two bookings together.
 *
 * Pure and client-safe.
 */

import type { StayLink } from "@/types/reservation";

/** The fields stay logic reads — a subset of `Reservation`. */
export interface StayRef {
  reservationNumber: string;
  checkInDate: string;
  checkOutDate: string;
  isCancelled?: boolean;
  isBlackout?: boolean;
  stayLink?: StayLink | null;
  stayLinkRejected?: string[];
  firstName?: string;
  lastName?: string;
}

/** Contact details suggestions match on, on top of `StayRef`. */
export interface SuggestRef extends StayRef {
  email?: string;
  additionalEmail?: string;
  phone?: string;
}

/**
 * Normalised guest identity — the full name, case-, diacritics-, punctuation-
 * and word-order-insensitive ("Piotr Marczewski" = "MARCZEWSKI piotr").
 */
export function guestKeyOf(r: { firstName?: string; lastName?: string }): string | undefined {
  const tokens = `${r.firstName ?? ""} ${r.lastName ?? ""}`
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter(Boolean)
    .sort();
  return tokens.length > 0 ? tokens.join(" ") : undefined;
}

/** A live guest booking — cancelled bookings and blackouts are never part of a stay. */
function linkable(r: StayRef): boolean {
  return !r.isCancelled && !r.isBlackout;
}

/** The operator said these two are different guests (either side may carry it). */
export function isRejectedPair(a: StayRef, b: StayRef): boolean {
  return (
    (a.stayLinkRejected ?? []).includes(b.reservationNumber) ||
    (b.stayLinkRejected ?? []).includes(a.reservationNumber)
  );
}

/**
 * Valid confirmed links as later → earlier reservation number. A link counts
 * only while its two bookings still meet — the earlier one checks out the day
 * the later one arrives — and neither is cancelled or a blackout. A shortened
 * or moved stay therefore drops out of its link on its own rather than
 * leaving a phantom. A booking continues at most one booking and is continued
 * by at most one; if two claim the same predecessor, the older link wins.
 */
export function confirmedLinks(all: readonly StayRef[]): Map<string, string> {
  const byId = new Map(all.map((r) => [r.reservationNumber, r]));
  const claims: { later: StayRef; earlier: StayRef }[] = [];
  for (const later of all) {
    const prev = later.stayLink?.prev;
    if (!prev) continue;
    const earlier = byId.get(prev);
    if (!earlier || earlier === later) continue;
    if (!linkable(later) || !linkable(earlier)) continue;
    if (earlier.checkOutDate !== later.checkInDate) continue;
    claims.push({ later, earlier });
  }
  claims.sort(
    (a, b) =>
      (a.later.stayLink?.linkedAt ?? "").localeCompare(b.later.stayLink?.linkedAt ?? "") ||
      a.later.reservationNumber.localeCompare(b.later.reservationNumber),
  );
  const prevOf = new Map<string, string>();
  const continued = new Set<string>();
  for (const { later, earlier } of claims) {
    if (continued.has(earlier.reservationNumber)) continue;
    prevOf.set(later.reservationNumber, earlier.reservationNumber);
    continued.add(earlier.reservationNumber);
  }
  return prevOf;
}

export interface StayChain<T extends StayRef = StayRef> {
  /** The bookings of the stay, in date order (2 or more). */
  members: T[];
  checkInDate: string;
  checkOutDate: string;
  nights: number;
}

function nightsBetween(from: string, to: string): number {
  return Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86_400_000);
}

/** Every confirmed multi-booking stay. */
export function stayChains<T extends StayRef>(all: readonly T[]): StayChain<T>[] {
  const prevOf = confirmedLinks(all);
  if (prevOf.size === 0) return [];
  const byId = new Map(all.map((r) => [r.reservationNumber, r]));
  const nextOf = new Map<string, string>();
  for (const [later, earlier] of prevOf) nextOf.set(earlier, later);

  const chains: StayChain<T>[] = [];
  for (const earlier of nextOf.keys()) {
    if (prevOf.has(earlier)) continue; // not the start of its chain
    const members: T[] = [];
    let id: string | undefined = earlier;
    while (id) {
      const r = byId.get(id);
      if (!r) break;
      members.push(r);
      id = nextOf.get(id);
    }
    const first = members[0];
    const last = members[members.length - 1];
    chains.push({
      members,
      checkInDate: first.checkInDate,
      checkOutDate: last.checkOutDate,
      nights: nightsBetween(first.checkInDate, last.checkOutDate),
    });
  }
  return chains.sort((a, b) => a.checkInDate.localeCompare(b.checkInDate));
}

/** reservationNumber → the confirmed stay it belongs to (only bookings in one). */
export function stayChainIndex<T extends StayRef>(all: readonly T[]): Map<string, StayChain<T>> {
  const index = new Map<string, StayChain<T>>();
  for (const chain of stayChains(all)) {
    for (const m of chain.members) index.set(m.reservationNumber, chain);
  }
  return index;
}

// ─── Suggestions ──────────────────────────────────────────────────────────────

/** What made two back-to-back bookings look like one guest. */
export type StaySignal = "name" | "email" | "phone";

export interface StaySuggestion<T extends SuggestRef = SuggestRef> {
  earlier: T;
  later: T;
  signals: StaySignal[];
}

/** Channel relay addresses — shared by every guest of that channel, so never an identity. */
const RELAY_EMAIL = /@(?:guest\.booking\.com|guest\.airbnb\.com|stayforlong\.com|m\.expediapartnercentral\.com)$/i;

function emailsOf(r: SuggestRef): Set<string> {
  const out = new Set<string>();
  for (const raw of [r.email, r.additionalEmail]) {
    const e = (raw ?? "").trim().toLowerCase();
    if (e.includes("@") && !RELAY_EMAIL.test(e)) out.add(e);
  }
  return out;
}

/**
 * A phone number reduced to its last 9 digits, so "+48 700 100 200" and
 * "700100200" agree. Fewer than 9 digits is too weak to identify anyone.
 */
export function phoneKeyOf(phone: string | undefined): string | undefined {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= 9 ? digits.slice(-9) : undefined;
}

function shares<T>(a: Set<T>, b: Set<T>): boolean {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

/**
 * Back-to-back pairs that look like one guest but aren't linked yet: the
 * earlier booking checks out the day the later one arrives (any apartment —
 * extensions often change unit), that day is today or later, neither booking
 * is cancelled or a blackout, neither side is already linked in that
 * direction, the operator hasn't said "not the same guest", and at least one
 * identity signal matches: name, a real email, or a phone number. Free text in
 * Beds24 comments never counts — "Extension of the reservation" says nothing
 * about WHOSE reservation (it would pair BH-93987993 with an unrelated O.308
 * guest checking out the same day).
 */
export function staySuggestions<T extends SuggestRef>(all: readonly T[], today: string): StaySuggestion<T>[] {
  const prevOf = confirmedLinks(all);
  const continued = new Set(prevOf.values());
  const live = all.filter(linkable);
  const byArrival = new Map<string, T[]>();
  for (const r of live) {
    const list = byArrival.get(r.checkInDate);
    if (list) list.push(r);
    else byArrival.set(r.checkInDate, [r]);
  }

  const out: StaySuggestion<T>[] = [];
  for (const earlier of live) {
    if (earlier.checkOutDate < today) continue; // the handover is history
    if (continued.has(earlier.reservationNumber)) continue;
    for (const later of byArrival.get(earlier.checkOutDate) ?? []) {
      if (later === earlier || prevOf.has(later.reservationNumber)) continue;
      if (isRejectedPair(earlier, later)) continue;
      const signals: StaySignal[] = [];
      const nameKey = guestKeyOf(earlier);
      if (nameKey && nameKey === guestKeyOf(later)) signals.push("name");
      if (shares(emailsOf(earlier), emailsOf(later))) signals.push("email");
      const phone = phoneKeyOf(earlier.phone);
      if (phone && phone === phoneKeyOf(later.phone)) signals.push("phone");
      if (signals.length > 0) out.push({ earlier, later, signals });
    }
  }
  return out.sort(
    (a, b) =>
      a.earlier.checkOutDate.localeCompare(b.earlier.checkOutDate) ||
      a.earlier.reservationNumber.localeCompare(b.earlier.reservationNumber) ||
      a.later.reservationNumber.localeCompare(b.later.reservationNumber),
  );
}

// ─── Room resolver identity ───────────────────────────────────────────────────

/**
 * "Same stay" identity for the room resolver (`buildGroupInputs`,
 * `verifyPlan`). Two back-to-back bookings belong to one stay when:
 *   - the operator linked them (whatever the names), or
 *   - they carry the same guest name and the operator has NOT said "not the
 *     same guest" (the original heuristic — over-matching only keeps two
 *     bookings together, never double-books).
 * Returns one key per booking that is part of such a stay, shared by every
 * booking of it; a booking that continues nobody gets no key. The resolver
 * only ever compares keys of bookings that meet, so a key is effectively a
 * pairwise answer. (Exception, accepted: two same-name parties handing over
 * on the same day can join a rejected pair transitively. That errs the safe
 * way — the two get moved together — and needs four bookings to line up.)
 */
export function sameStayKeys(all: readonly StayRef[]): Map<string, string> {
  const live = all.filter(linkable);
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!;
    // Path compression keeps the walk short on long chains.
    let cur = x;
    while (cur !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // The smaller reservation number roots the set, so the key is stable.
    if (ra < rb) parent.set(rb, ra);
    else parent.set(ra, rb);
  };

  for (const [later, earlier] of confirmedLinks(all)) union(later, earlier);

  const byArrival = new Map<string, StayRef[]>();
  for (const r of live) {
    const list = byArrival.get(r.checkInDate);
    if (list) list.push(r);
    else byArrival.set(r.checkInDate, [r]);
  }
  for (const a of live) {
    const key = guestKeyOf(a);
    if (!key) continue;
    for (const b of byArrival.get(a.checkOutDate) ?? []) {
      if (b === a || isRejectedPair(a, b) || guestKeyOf(b) !== key) continue;
      union(a.reservationNumber, b.reservationNumber);
    }
  }

  const keys = new Map<string, string>();
  for (const id of parent.keys()) keys.set(id, `stay:${find(id)}`);
  return keys;
}
