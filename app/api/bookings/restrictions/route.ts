/**
 * /api/bookings/restrictions: Beds24 check-in / check-out restrictions.
 *
 *   GET                         → { restrictions: StayRestriction[] }, ~60 days back to a year ahead
 *   POST { roomIds, kind, from, to } → sets the restriction on the room each selection is SOLD as
 *   DELETE ?id=RS-<roomId>-<kind>-<from>-<to> → resets those days to `none`
 *
 * These are Beds24 calendar overrides, the same field as blackouts, but they are
 * kept out of /api/bookings on purpose. A restriction closes no night, so it must
 * never reach anything that counts reservations (occupancy, revenue, the bookings
 * mirror, the cleaning app). See utils/stayRestrictions.ts for why the write goes
 * to the virtual room for Urban / Deluxe 1KK while a blackout goes to the units.
 *
 * `from` / `to` are DAYS, both inclusive. Blackouts use arrival/departure nights.
 *
 * Auth: admin / super only, like blackouts.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { getAccessToken } from '@/utils/beds24Auth';
import { BEDS24_API_BASE, getRedis } from '@/utils/beds24Reservations';
import { pragueToday } from '@/utils/periodUtils';
import {
  RESTRICTION_LABEL,
  RESTRICTION_ROOM_IDS,
  addDays,
  eachDay,
  isRestrictionKind,
  isYmd,
  overrideByDay,
  parseRestrictionId,
  planRestrictionClear,
  planRestrictionWrite,
  restrictionsForRoom,
  unitForRoomId,
  type CalendarOverrideEntry,
  type SellableUnit,
  type StayRestriction,
} from '@/utils/stayRestrictions';

const CACHE_KEY = 'baker:stay-restrictions-cache';
const CACHE_TTL_SECONDS = 5 * 60;
const MAX_RANGE_DAYS = 366;
/** Beds24 pages calendar responses. 9 rooms × a year fits in one, but never act on a partial read. */
const MAX_CALENDAR_PAGES = 10;

async function invalidateCache(): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(CACHE_KEY);
  } catch (err) {
    console.warn('[restrictions] cache invalidation failed:', err);
  }
}

/**
 * Current override per day for each room. One request covers every room (the
 * calendar GET takes repeated `roomId`). Throws unless every room came back, so
 * a write is never planned against half a calendar.
 */
async function readOverrides(
  token: string,
  roomIds: readonly number[],
  startDate: string,
  endDate: string,
): Promise<Map<number, Record<string, string>>> {
  const entriesByRoom = new Map<number, CalendarOverrideEntry[]>();
  for (let page = 1; page <= MAX_CALENDAR_PAGES; page++) {
    const params = new URLSearchParams({ startDate, endDate, includeOverride: 'true' });
    for (const id of roomIds) params.append('roomId', String(id));
    if (page > 1) params.set('page', String(page));

    const res = await fetch(`${BEDS24_API_BASE}/inventory/rooms/calendar?${params}`, {
      headers: { token },
      cache: 'no-store',
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Beds24 calendar ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      data?: { roomId?: number; calendar?: CalendarOverrideEntry[] }[];
      pages?: { nextPageExists?: boolean };
    };
    for (const row of json.data ?? []) {
      if (typeof row.roomId !== 'number') continue;
      const list = entriesByRoom.get(row.roomId) ?? [];
      list.push(...(row.calendar ?? []));
      entriesByRoom.set(row.roomId, list);
    }
    if (!json.pages?.nextPageExists) {
      const missing = roomIds.filter((id) => !entriesByRoom.has(id));
      if (missing.length > 0) {
        throw new Error(`Beds24 calendar returned no data for room(s) ${missing.join(', ')}`);
      }
      const byRoom = new Map<number, Record<string, string>>();
      for (const [roomId, entries] of entriesByRoom) byRoom.set(roomId, overrideByDay(entries));
      return byRoom;
    }
  }
  throw new Error(`Beds24 calendar still paginating after ${MAX_CALENDAR_PAGES} pages`);
}

/** POST calendar writes and surface any per-room rejection (Beds24 answers 201 per item). */
async function writeCalendar(
  token: string,
  payload: { roomId: number; calendar: { from: string; to: string; override: string }[] }[],
): Promise<void> {
  const res = await fetch(`${BEDS24_API_BASE}/inventory/rooms/calendar`, {
    method: 'POST',
    headers: { token, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    cache: 'no-store',
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Beds24 ${res.status}: ${text.slice(0, 300)}`);
  let items: unknown;
  try {
    items = JSON.parse(text);
  } catch {
    return; // accepted, body just isn't JSON
  }
  if (!Array.isArray(items)) return;
  const rejected = items.filter(
    (item) =>
      item &&
      typeof item === 'object' &&
      ((item as { success?: unknown }).success === false ||
        ((item as { errors?: unknown[] }).errors?.length ?? 0) > 0),
  );
  if (rejected.length > 0) {
    throw new Error(`Beds24 rejected the change: ${JSON.stringify(rejected).slice(0, 300)}`);
  }
}

function errorResponse(err: unknown, status = 502): NextResponse {
  return NextResponse.json(
    { error: err instanceof Error ? err.message : String(err) },
    { status },
  );
}

export async function GET() {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  const redis = getRedis();
  if (redis) {
    const cached = await redis.get<StayRestriction[]>(CACHE_KEY).catch(() => null);
    if (cached) return NextResponse.json({ restrictions: cached });
  }

  try {
    const token = await getAccessToken();
    const today = pragueToday();
    const byRoom = await readOverrides(token, RESTRICTION_ROOM_IDS, addDays(today, -60), addDays(today, 365));
    const restrictions = [...byRoom.entries()]
      .flatMap(([roomId, byDay]) => restrictionsForRoom(roomId, byDay))
      .sort((a, b) => a.from.localeCompare(b.from) || a.unitLabel.localeCompare(b.unitLabel));
    if (redis) {
      await redis.set(CACHE_KEY, restrictions, { ex: CACHE_TTL_SECONDS }).catch(() => {});
    }
    return NextResponse.json({ restrictions });
  } catch (err) {
    console.error('[restrictions] GET failed:', err);
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest) {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  let body: { roomIds?: unknown; kind?: unknown; from?: unknown; to?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const { roomIds, kind, from, to } = body;

  if (!isRestrictionKind(kind)) {
    return NextResponse.json({ error: 'kind must be noCheckIn, noCheckOut or noCheckInOrCheckOut' }, { status: 400 });
  }
  if (!isYmd(from) || !isYmd(to)) {
    return NextResponse.json({ error: 'from and to must be YYYY-MM-DD' }, { status: 400 });
  }
  if (to < from) {
    return NextResponse.json({ error: 'The last day must be on or after the first day' }, { status: 400 });
  }
  if (from < pragueToday()) {
    return NextResponse.json({ error: 'Restrictions can only be set from today onwards' }, { status: 400 });
  }
  if (eachDay(from, to).length > MAX_RANGE_DAYS) {
    return NextResponse.json({ error: `Pick at most ${MAX_RANGE_DAYS} days at a time` }, { status: 400 });
  }
  if (!Array.isArray(roomIds) || roomIds.length === 0) {
    return NextResponse.json({ error: 'Pick at least one room' }, { status: 400 });
  }

  // Resolve each picked room to the unit it is sold as. Picking K.102 means the
  // whole Urban type, because that is the only thing a guest can book.
  const units = new Map<number, SellableUnit>();
  for (const id of roomIds) {
    const unit = typeof id === 'number' ? unitForRoomId(id) : null;
    if (!unit) return NextResponse.json({ error: `Unknown room ${String(id)}` }, { status: 400 });
    units.set(unit.roomId, unit);
  }

  try {
    const token = await getAccessToken();
    const byRoom = await readOverrides(token, [...units.keys()], from, to);

    const payload: { roomId: number; calendar: { from: string; to: string; override: string }[] }[] = [];
    const conflicts: { unit: string; date: string; override: string }[] = [];
    const merged: { unit: string; dates: string[] }[] = [];
    for (const [roomId, unit] of units) {
      const plan = planRestrictionWrite(byRoom.get(roomId) ?? {}, from, to, kind);
      conflicts.push(...plan.conflicts.map((c) => ({ unit: unit.label, ...c })));
      if (plan.merged.length > 0) merged.push({ unit: unit.label, dates: plan.merged });
      if (plan.writes.length > 0) payload.push({ roomId, calendar: plan.writes });
    }

    if (conflicts.length > 0) {
      const list = conflicts.map((c) => `${c.unit} ${c.date} (${c.override})`).join(', ');
      return NextResponse.json(
        {
          error: `Nothing was changed. These days already carry a Beds24 override, and a day can only hold one: ${list}. Remove it first.`,
          conflicts,
        },
        { status: 409 },
      );
    }

    if (payload.length > 0) await writeCalendar(token, payload);
    await invalidateCache();

    return NextResponse.json({
      ok: true,
      kind,
      label: RESTRICTION_LABEL[kind],
      units: [...units.values()].map((u) => u.label),
      merged,
      alreadySet: payload.length === 0,
    });
  } catch (err) {
    console.error('[restrictions] POST failed:', err);
    return errorResponse(err);
  }
}

export async function DELETE(req: NextRequest) {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  const parsed = parseRestrictionId(req.nextUrl.searchParams.get('id') ?? '');
  if (!parsed || !RESTRICTION_ROOM_IDS.includes(parsed.roomId)) {
    return NextResponse.json(
      { error: 'id must be RS-<roomId>-<kind>-<from>-<to> for a Baker House room' },
      { status: 400 },
    );
  }

  try {
    const token = await getAccessToken();
    const byRoom = await readOverrides(token, [parsed.roomId], parsed.from, parsed.to);
    const ranges = planRestrictionClear(byRoom.get(parsed.roomId) ?? {}, parsed.from, parsed.to, parsed.kind);
    if (ranges.length > 0) {
      await writeCalendar(token, [
        { roomId: parsed.roomId, calendar: ranges.map((r) => ({ ...r, override: 'none' })) },
      ]);
    }
    await invalidateCache();
    return NextResponse.json({
      ok: true,
      clearedDays: ranges.reduce((n, r) => n + eachDay(r.from, r.to).length, 0),
    });
  } catch (err) {
    console.error('[restrictions] DELETE failed:', err);
    return errorResponse(err);
  }
}
