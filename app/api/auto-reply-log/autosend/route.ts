/**
 * GET/POST /api/auto-reply-log/autosend
 *
 * The operator's control for which auto-reply categories skip the review queue
 * and auto-send. Backed by Postgres app_settings (see data-access). Admin/super
 * only. The webhook's aiReviewDraft reads the same setting to decide send vs
 * queue.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import {
  readAutoSendCategories,
  writeAutoSendCategories,
} from '@/data-access/autoSendCategories';

export async function GET() {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;
  const categories = await readAutoSendCategories();
  return NextResponse.json({ categories });
}

export async function POST(req: NextRequest) {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  let body: { categories?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (
    !Array.isArray(body.categories) ||
    !body.categories.every((c) => typeof c === 'string')
  ) {
    return NextResponse.json({ error: '`categories` must be an array of strings' }, { status: 400 });
  }

  const categories = await writeAutoSendCategories(body.categories as string[]);
  return NextResponse.json({ ok: true, categories });
}
