/**
 * /api/admin/users — the user list behind /admin/users. Admin only.
 *
 *   GET                         → users, env break-glass admins, last 50 changes
 *   POST   { email, role, note? } → add a user or change their role / note
 *   DELETE ?email=…             → remove a user (their session ends within a minute)
 *
 * Every change is written to app_user_changes. Emails are stored lower-cased.
 */
import { NextRequest, NextResponse } from 'next/server';
import { desc, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { appUserChanges, appUsers } from '@/lib/db/schema';
import { requireAccess } from '@/utils/authGuard';
import { isRole } from '@/utils/roles';
import { envAdminEmails, forgetCachedRole, normalizeEmail } from '@/utils/userRoles';

export const dynamic = 'force-dynamic';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Postgres "undefined table" — migration 0026 hasn't run on this database yet. */
function dbError(err: unknown): NextResponse {
  const cause = (err as { cause?: { code?: string } } | null)?.cause;
  const missing = cause?.code === '42P01';
  console.error('[admin/users]', err);
  return NextResponse.json(
    {
      error: missing
        ? 'The users table does not exist yet — run the database migration (npm run db:migrate) first.'
        : `Database error: ${err instanceof Error ? err.message : String(err)}`,
    },
    { status: 500 },
  );
}

export async function GET() {
  const guard = await requireAccess('users', 'view');
  if ('error' in guard) return guard.error;

  let users, changes;
  try {
    [users, changes] = await Promise.all([
      db.select().from(appUsers).orderBy(appUsers.email),
      db.select().from(appUserChanges).orderBy(desc(appUserChanges.changedAt)).limit(50),
    ]);
  } catch (err) {
    return dbError(err);
  }
  return NextResponse.json({ users, changes, envAdmins: envAdminEmails(), me: normalizeEmail(guard.email) });
}

export async function POST(req: NextRequest) {
  const guard = await requireAccess('users', 'change');
  if ('error' in guard) return guard.error;

  const body = (await req.json().catch(() => null)) as { email?: unknown; role?: unknown; note?: unknown } | null;
  const email = typeof body?.email === 'string' ? normalizeEmail(body.email) : '';
  if (!EMAIL_RE.test(email)) return NextResponse.json({ error: 'A valid email is required' }, { status: 400 });
  if (!isRole(body?.role)) return NextResponse.json({ error: 'Unknown role' }, { status: 400 });
  if (envAdminEmails().includes(email)) {
    return NextResponse.json(
      { error: `${email} is an admin through ADMIN_EMAILS in Vercel; change it there.` },
      { status: 400 },
    );
  }
  const note = typeof body?.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 200) : null;
  const by = normalizeEmail(guard.email);

  const role = body.role;
  try {
    const [existing] = await db.select().from(appUsers).where(eq(appUsers.email, email)).limit(1);
    const now = new Date();
    await db
      .insert(appUsers)
      .values({ email, role, note, updatedBy: by, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: appUsers.email, set: { role, note, updatedBy: by, updatedAt: now } });
    if (existing?.role !== role) {
      await db.insert(appUserChanges).values({ email, oldRole: existing?.role ?? null, newRole: role, changedBy: by });
    }
  } catch (err) {
    return dbError(err);
  }
  forgetCachedRole(email);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const guard = await requireAccess('users', 'change');
  if ('error' in guard) return guard.error;

  const email = normalizeEmail(req.nextUrl.searchParams.get('email') ?? '');
  if (!email) return NextResponse.json({ error: 'email is required' }, { status: 400 });
  if (email === normalizeEmail(guard.email)) {
    return NextResponse.json({ error: "You can't remove yourself" }, { status: 400 });
  }

  try {
    const [existing] = await db.select().from(appUsers).where(eq(appUsers.email, email)).limit(1);
    if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    await db.delete(appUsers).where(eq(appUsers.email, email));
    await db.insert(appUserChanges).values({
      email,
      oldRole: existing.role,
      newRole: null,
      changedBy: normalizeEmail(guard.email),
    });
  } catch (err) {
    return dbError(err);
  }
  forgetCachedRole(email);
  return NextResponse.json({ ok: true });
}
