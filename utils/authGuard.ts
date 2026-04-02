import { auth } from '@/auth';
import { NextResponse } from 'next/server';
import type { Role } from '@/utils/roles';

/** Call at the top of any API route handler that requires specific roles.
 *  Returns { role } on success or { error: NextResponse } on failure. */
export async function requireRole(
  allowedRoles: Role[]
): Promise<{ role: Role } | { error: NextResponse }> {
  const session = await auth();
  if (!session?.user) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  const role = (session.user as { role?: Role }).role;
  if (!role || !allowedRoles.includes(role)) {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  return { role };
}
