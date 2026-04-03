import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

// ── Redis keys (must match baker-house-cleaning/src/lib/storage.ts) ──────────
const KEY_CLEANERS_CONFIG = 'baker:cleaners-config';
const KEY_CLEANING_ASSIGNMENTS = 'baker:cleaning-assignments';
const KEY_LAUNDRY_CONFIG = 'baker:laundry-config';
const KEY_LAUNDRY_ASSIGNMENTS = 'baker:laundry-assignments';
const KEY_CONSUMABLE_ENTRIES = 'baker:consumable-entries';

// ── Room mapping: Beds24 roomId → reporting display name ─────────────────────
// Matches cleaning app src/lib/room-mapping.ts + reporting types/reservation.ts
export const BEDS24_ID_TO_ROOM: Record<string, string> = {
  '656437': 'K.201',
  '648596': 'K.202',
  '648772': 'K.203',
};

// Reverse: reporting room display name → Beds24 roomId
export const ROOM_TO_BEDS24_ID: Record<string, string> = Object.fromEntries(
  Object.entries(BEDS24_ID_TO_ROOM).map(([id, name]) => [name, id])
);

// ── Types mirrored from cleaning app ─────────────────────────────────────────
interface CleanersConfig {
  cleaners: { id: string; name: string }[];
  rates: Record<string, Record<string, number>>; // rates[cleanerId][roomId]
}

interface LaundryConfig {
  providers: { id: string; name: string }[];
  rates: Record<string, Record<string, number>>; // rates[providerId][roomId]
}

// Cleaning assignments: nested date → roomId → cleanerId
type CleaningAssignmentsNested = Record<string, Record<string, string>>;

// Laundry assignments: flat "date|roomId" → providerId
type LaundryAssignmentsFlat = Record<string, string | null>;

interface ConsumableEntry {
  id: string;
  date: string;
  roomId: string;
  amount: number;
}

export interface VariableCostEntry {
  cleaning: number;
  laundry: number;
  consumables: number;
}

// ── Response type: lookup by "date|roomId" (Beds24 roomId) ───────────────────
export type VariableCostsLookup = Record<string, VariableCostEntry>;

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export async function GET() {
  const redis = getRedis();
  if (!redis) {
    return NextResponse.json({ error: 'Redis not configured' }, { status: 503 });
  }

  // Fetch all 5 keys in parallel
  const [cleanersRaw, assignmentsRaw, laundryRaw, laundryAssignmentsRaw, entriesRaw] =
    await Promise.all([
      redis.get(KEY_CLEANERS_CONFIG),
      redis.get(KEY_CLEANING_ASSIGNMENTS),
      redis.get(KEY_LAUNDRY_CONFIG),
      redis.get(KEY_LAUNDRY_ASSIGNMENTS),
      redis.get(KEY_CONSUMABLE_ENTRIES),
    ]);

  const cleanersConfig = (cleanersRaw ?? { cleaners: [], rates: {} }) as CleanersConfig;
  const cleaningAssignments = (assignmentsRaw ?? {}) as CleaningAssignmentsNested;
  const laundryConfig = (laundryRaw ?? { providers: [], rates: {} }) as LaundryConfig;
  const laundryAssignments = (laundryAssignmentsRaw ?? {}) as LaundryAssignmentsFlat;
  const consumableEntries = (entriesRaw ?? []) as ConsumableEntry[];

  const lookup: VariableCostsLookup = {};

  function ensureEntry(date: string, roomId: string): VariableCostEntry {
    const key = `${date}|${roomId}`;
    if (!lookup[key]) lookup[key] = { cleaning: 0, laundry: 0, consumables: 0 };
    return lookup[key];
  }

  // ── Cleaning: nested assignments[date][roomId] → cleanerId → rate ────────
  for (const [date, rooms] of Object.entries(cleaningAssignments)) {
    for (const [roomId, cleanerId] of Object.entries(rooms)) {
      if (!cleanerId) continue;
      const rate = cleanersConfig.rates[cleanerId]?.[roomId] ?? 0;
      if (rate > 0) {
        ensureEntry(date, roomId).cleaning = rate;
      }
    }
  }

  // ── Laundry: flat assignments["date|roomId"] → providerId → rate ─────────
  for (const [key, providerId] of Object.entries(laundryAssignments)) {
    if (!providerId) continue;
    const [date, roomId] = key.split('|');
    if (!date || !roomId) continue;
    const rate = laundryConfig.rates[providerId]?.[roomId] ?? 0;
    if (rate > 0) {
      ensureEntry(date, roomId).laundry = rate;
    }
  }

  // ── Consumables: sum entries by date+roomId ───────────────────────────────
  for (const entry of consumableEntries) {
    if (entry.amount > 0) {
      ensureEntry(entry.date, entry.roomId).consumables += entry.amount;
    }
  }

  return NextResponse.json(lookup);
}
