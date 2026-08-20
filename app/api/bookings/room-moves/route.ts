/**
 * Room-move notices — the persistent "this reservation was moved" alert feed.
 *
 *   GET  /api/bookings/room-moves        → { moves: [...] } open notices, newest first
 *   POST /api/bookings/room-moves        → dismiss; body { ids: string[] } or { all: true }
 *
 * Notices are WRITTEN by the two endpoints that actually move a booking
 * (`/api/bookings/relocate` and `/api/bookings/move`), never by the client — a
 * client-supplied notice could claim a move that never happened.
 *
 * admin/super only, matching the Transactions tab the alert bar lives on.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/utils/authGuard";
import { dismissRoomMoves, listOpenRoomMoves } from "@/data-access/roomMoves";

export async function GET() {
  const guard = await requireRole(["admin", "super"]);
  if ("error" in guard) return guard.error;

  try {
    return NextResponse.json({ moves: await listOpenRoomMoves() });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load move notices" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  const guard = await requireRole(["admin", "super"]);
  if ("error" in guard) return guard.error;

  let body: { ids?: unknown; all?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const all = body.all === true;
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((i): i is string => typeof i === "string" && i.length > 0)
    : [];

  if (!all && ids.length === 0) {
    return NextResponse.json({ error: "Provide ids[] or all: true" }, { status: 400 });
  }

  try {
    const dismissed = await dismissRoomMoves(ids, guard.email, all);
    return NextResponse.json({ ok: true, dismissed });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Dismiss failed" },
      { status: 500 },
    );
  }
}
