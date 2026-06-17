/**
 * GET /api/public/occupancy/[token] — PUBLIC (no auth).
 *
 * Returns the frozen, PII-free snapshot for a share token, or 404 if the
 * token is unknown / revoked / expired. The operator email is stripped
 * via toPublicSnapshot. Exempted from auth in proxy.ts (matcher excludes
 * `api/public`).
 */

import { NextResponse } from 'next/server';
import { getSnapshot } from '@/utils/occupancySnapshotStore';
import { toPublicSnapshot } from '@/types/occupancySnapshot';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  if (!token) {
    return NextResponse.json({ error: 'token required' }, { status: 400 });
  }

  const snap = await getSnapshot(token);
  if (!snap) {
    return NextResponse.json({ error: 'Snapshot not found or expired' }, { status: 404 });
  }

  return NextResponse.json(toPublicSnapshot(snap), {
    headers: { 'Cache-Control': 'public, max-age=60' },
  });
}
