import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { appUsers } from '@/lib/db/schema';
import { isRole, type Role } from '@/utils/roles';

/**
 * Server-only: which role an email has right now.
 *
 * Order:
 *  1. env `ADMIN_EMAILS` → always admin (break-glass; a bad edit on
 *     /admin/users can never lock the owner out).
 *  2. the `app_users` table, cached for 60 s per server instance — auth.ts
 *     calls this on every request, so a change lands within a minute.
 *  3. ONLY if the table can't be read (e.g. before migration 0026 ran): the old
 *     env lists, with viewer → user and accountant dropped.
 */

const CACHE_MS = 60_000;
const cache = new Map<string, { role: Role | null; at: number }>();

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function envList(name: string): string[] {
  return (process.env[name] ?? '').split(',').map(normalizeEmail).filter(Boolean);
}

export function envAdminEmails(): string[] {
  return envList('ADMIN_EMAILS');
}

function legacyEnvRole(email: string): Role | null {
  if (envList('SUPER_EMAILS').includes(email)) return 'super';
  if (envList('VIEWER_EMAILS').includes(email)) return 'user';
  if (envList('OCCUPANCY_EMAILS').includes(email)) return 'occupancy';
  return null;
}

export async function resolveRole(email: string | null | undefined): Promise<Role | null> {
  const e = normalizeEmail(email ?? '');
  if (!e) return null;
  if (envAdminEmails().includes(e)) return 'admin';

  const hit = cache.get(e);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.role;

  let role: Role | null;
  try {
    const rows = await db.select({ role: appUsers.role }).from(appUsers).where(eq(appUsers.email, e)).limit(1);
    role = rows[0] && isRole(rows[0].role) ? rows[0].role : null;
  } catch (err) {
    console.error('[userRoles] app_users lookup failed — using the env lists:', err);
    role = legacyEnvRole(e);
  }
  cache.set(e, { role, at: Date.now() });
  return role;
}

/** Drop this instance's cached answer after an edit (other instances catch up within 60 s). */
export function forgetCachedRole(email: string): void {
  cache.delete(normalizeEmail(email));
}
