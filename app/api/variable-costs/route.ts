import { NextResponse } from 'next/server';
import { computeVariableCosts } from '@/utils/variableCostsEngine';

// Bypass Next.js's static route-handler cache — must read live Redis state
// on every request, otherwise newly logged consumable / assignment / pickup
// entries don't surface in the reporting dashboard until a redeploy.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * The calculation itself lives in `utils/variableCostsEngine.ts` so the
 * analytics cost view can call it directly instead of re-implementing cost
 * logic that would drift from this endpoint. This route is the HTTP shape only.
 *
 * Room mapping and the response contract stay in `@/utils/variableCostsShared`
 * and are deliberately NOT re-exported from here: a value import from a route
 * handler drags its server-only dependencies into the client bundle.
 */
export async function GET() {
  const body = await computeVariableCosts();
  if (!body) {
    return NextResponse.json({ error: 'Redis not configured' }, { status: 503 });
  }
  return NextResponse.json(body);
}
