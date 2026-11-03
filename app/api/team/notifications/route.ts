/**
 * Operator-to-operator notifications.
 *
 *   POST  /api/team/notifications  { recipient: email | 'all', text }  → { notification }
 *   PATCH /api/team/notifications  { ids: string[] }                   → mark read for me
 *
 * The author is the signed-in operator (auth guard), never the client.
 * admin/super only.
 */
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { requireRole } from '@/utils/authGuard';
import { createNotification, isKnownOperator, markNotificationsRead } from '@/data-access/team';
import { TEAM_ALL, validateTeamText } from '@/utils/teamItems';

export async function POST(req: NextRequest) {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  let body: { recipient?: unknown; text?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const recipient = typeof body.recipient === 'string' ? body.recipient : '';
  if (recipient !== TEAM_ALL && !isKnownOperator(recipient, guard.email)) {
    return NextResponse.json({ error: 'Pick who the notification is for.' }, { status: 400 });
  }
  const text = validateTeamText(body.text);
  if ('error' in text) return NextResponse.json({ error: text.error }, { status: 400 });

  try {
    const session = await auth();
    const notification = await createNotification({
      recipient,
      text: text.text,
      createdBy: guard.email,
      createdByName: session?.user?.name ?? null,
    });
    return NextResponse.json({ ok: true, notification });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to send notification' },
      { status: 500 },
    );
  }
}

export async function PATCH(req: NextRequest) {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  let body: { ids?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((i): i is string => typeof i === 'string' && i.length > 0)
    : [];
  if (ids.length === 0) return NextResponse.json({ error: 'Provide ids[]' }, { status: 400 });

  try {
    const read = await markNotificationsRead(ids, guard.email);
    return NextResponse.json({ ok: true, read });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to mark read' },
      { status: 500 },
    );
  }
}
