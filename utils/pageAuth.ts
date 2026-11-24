import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { can, isRole, type Access, type Area, type Role } from '@/utils/roles';

/**
 * For server pages outside the main app (/auto-reply-log, /admin/users): the
 * signed-in role, or a redirect home when it may not open `area`. Honours the
 * same local dev bypass as utils/authGuard (DEV_ADMIN_EMAIL + optional DEV_ROLE).
 */
export async function requirePageAccess(area: Area, access: Access = 'view'): Promise<{ role: Role; email: string }> {
  if (process.env.NODE_ENV === 'development' && process.env.DEV_ADMIN_EMAIL) {
    const role = isRole(process.env.DEV_ROLE) ? process.env.DEV_ROLE : 'admin';
    if (!can(role, area, access)) redirect('/');
    return { role, email: process.env.DEV_ADMIN_EMAIL };
  }
  const session = await auth();
  const role = (session?.user as { role?: Role } | undefined)?.role;
  if (!role || !can(role, area, access)) redirect(role === 'occupancy' ? '/occupancy' : '/');
  return { role, email: session?.user?.email ?? 'unknown' };
}
