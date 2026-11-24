import { auth } from '@/auth';
import { NextResponse } from 'next/server';
import { PERMISSIONS, isRole, type Access, type Area, type Role } from '@/utils/roles';

/** Local dev bypass: DEV_ADMIN_EMAIL skips Google auth; DEV_ROLE (optional)
 *  picks the role to test as, default admin. */
function devIdentity(): { role: Role; email: string } | null {
  if (process.env.NODE_ENV !== 'development' || !process.env.DEV_ADMIN_EMAIL) return null;
  const role = isRole(process.env.DEV_ROLE) ? process.env.DEV_ROLE : 'admin';
  return { role, email: process.env.DEV_ADMIN_EMAIL };
}

/**
 * Low-level check against an explicit role list. API routes use
 * `requireAccess` instead, so the permission map in utils/roles.ts stays the
 * one place that decides (utils/apiGuards.test.ts enforces it).
 * Returns { role, email } on success or { error: NextResponse } on failure.
 */
export async function requireRole(
  allowedRoles: Role[],
): Promise<{ role: Role; email: string } | { error: NextResponse }> {
  const dev = devIdentity();
  if (dev) {
    if (!allowedRoles.includes(dev.role)) {
      return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
    }
    return dev;
  }

  const session = await auth();
  if (!session?.user) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  const role = (session.user as { role?: Role }).role;
  if (!role || !allowedRoles.includes(role)) {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  return { role, email: session.user.email ?? 'unknown' };
}

/** Call at the top of every API route handler: may this user view / change `area`? */
export function requireAccess(
  area: Area,
  access: Access,
): Promise<{ role: Role; email: string } | { error: NextResponse }> {
  return requireRole(PERMISSIONS[area][access]);
}
