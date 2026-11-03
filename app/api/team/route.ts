/**
 * GET /api/team → TeamFeed for the signed-in operator:
 *   { me, users, notifications (unread, addressed to me or everyone),
 *     tasks (open general tasks addressed to me / everyone / created by me) }
 *
 * One poll feeds both the Notifications pill and the general rows of the
 * Pending tasks pill. Also records the caller's Google name so the user picker
 * and banners can show names instead of emails.
 *
 * admin/super only, matching the Transactions tab the banners live on.
 */
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { requireRole } from '@/utils/authGuard';
import {
  listOpenGeneralTasks,
  listTeamUsers,
  listUnreadNotifications,
  rememberTeamName,
} from '@/data-access/team';
import { normalizeEmail, taskVisibleTo, type TeamFeed } from '@/utils/teamItems';

export const dynamic = 'force-dynamic';

export async function GET() {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;
  const me = normalizeEmail(guard.email);

  try {
    const session = await auth();
    await rememberTeamName(me, session?.user?.name);

    const [users, notifications, tasks] = await Promise.all([
      listTeamUsers(me),
      listUnreadNotifications(me),
      listOpenGeneralTasks(),
    ]);
    const feed: TeamFeed = {
      me,
      users,
      notifications,
      tasks: tasks.filter((t) => taskVisibleTo(t, me)),
    };
    return NextResponse.json(feed);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to load team feed' },
      { status: 500 },
    );
  }
}
