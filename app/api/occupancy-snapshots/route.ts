/**
 * Authed CRUD for shareable occupancy snapshots (admin/super only).
 *
 *   POST   — create a new snapshot, or regenerate an existing one
 *            (pass `token` to overwrite in place: fresh data + reset
 *            90-day clock, same public URL). Body: { data, token?,
 *            expiresInDays? }. Returns { token, url, snapshot }.
 *   GET    — list all live snapshots (newest first) for the management UI.
 *   DELETE — revoke a snapshot. ?token= or { token }.
 *
 * The `data` payload is computed client-side (utils/occupancySnapshot.ts)
 * from the reservations the Performance page already holds, so this route
 * never touches Beds24. It is PII-free by construction.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import {
  putSnapshot,
  listSnapshots,
  getSnapshot,
  deleteSnapshot,
} from '@/utils/occupancySnapshotStore';
import type { OccupancySnapshot, SnapshotData } from '@/types/occupancySnapshot';

const DEFAULT_EXPIRY_DAYS = 90;

function baseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_BASE_URL?.trim() ||
    'https://reporting.bakerhouseapartments.cz'
  );
}

function shareUrl(token: string): string {
  return `${baseUrl()}/share/occupancy/${token}`;
}

/** Light structural validation — enough to reject garbage, not a full schema. */
function isValidSnapshotData(d: unknown): d is SnapshotData {
  if (!d || typeof d !== 'object') return false;
  const x = d as Record<string, unknown>;
  const period = x.period as Record<string, unknown> | undefined;
  const metrics = x.metrics as Record<string, unknown> | undefined;
  const calendar = x.calendar as Record<string, unknown> | undefined;
  return (
    !!period &&
    typeof period.start === 'string' &&
    typeof period.end === 'string' &&
    typeof period.label === 'string' &&
    Array.isArray(x.rooms) &&
    typeof x.includeGrossSales === 'boolean' &&
    !!metrics &&
    typeof metrics.occupancyPct === 'number' &&
    Array.isArray(x.perRoom) &&
    !!calendar &&
    Array.isArray(calendar.dates) &&
    Array.isArray(calendar.perRoom)
  );
}

export async function POST(req: NextRequest) {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  let body: { data?: unknown; token?: string; expiresInDays?: number | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!isValidSnapshotData(body.data)) {
    return NextResponse.json({ error: 'Invalid or missing snapshot data' }, { status: 400 });
  }

  // Regenerate keeps the same public URL; create mints a fresh token.
  let token = body.token?.trim();
  if (token) {
    const existing = await getSnapshot(token);
    if (!existing) {
      return NextResponse.json({ error: 'Snapshot to regenerate not found or expired' }, { status: 404 });
    }
  } else {
    token = crypto.randomUUID();
  }

  const days =
    body.expiresInDays === null
      ? null
      : Number.isFinite(body.expiresInDays as number) && (body.expiresInDays as number) > 0
        ? (body.expiresInDays as number)
        : DEFAULT_EXPIRY_DAYS;

  const now = new Date();
  const expiresAt =
    days === null ? null : new Date(now.getTime() + days * 86_400_000).toISOString();

  const snapshot: OccupancySnapshot = {
    token,
    createdAt: now.toISOString(),
    createdBy: guard.email,
    expiresAt,
    data: body.data,
  };

  await putSnapshot(snapshot);

  return NextResponse.json({ token, url: shareUrl(token), snapshot });
}

export async function GET() {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  const snapshots = await listSnapshots();
  return NextResponse.json({
    snapshots: snapshots.map((s) => ({ ...s, url: shareUrl(s.token) })),
  });
}

export async function DELETE(req: NextRequest) {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  let token = req.nextUrl.searchParams.get('token')?.trim() || '';
  if (!token) {
    try {
      const body = await req.json();
      token = (body?.token ?? '').trim();
    } catch {
      /* no body */
    }
  }
  if (!token) {
    return NextResponse.json({ error: 'token is required' }, { status: 400 });
  }

  const removed = await deleteSnapshot(token);
  return NextResponse.json({ ok: true, removed });
}
