import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { requireRole } from '@/utils/authGuard';
import type { GmailInvoiceToken } from '../callback/route';

const TOKEN_KEY = 'baker:gmail-invoice-token';

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

/** GET /api/accounting/connect-gmail/status
 *  Returns whether the invoice Gmail account is connected. */
export async function GET() {
  const guard = await requireRole(['admin', 'accountant']);
  if ('error' in guard) return guard.error;

  const redis = getRedis();
  if (!redis) return NextResponse.json({ connected: false });

  const token = await redis.get(TOKEN_KEY) as GmailInvoiceToken | null;
  if (!token?.refreshToken) return NextResponse.json({ connected: false });

  return NextResponse.json({
    connected: true,
    email: token.email,
    connectedAt: token.connectedAt,
  });
}

/** DELETE /api/accounting/connect-gmail/status
 *  Disconnects the invoice Gmail account by removing the stored token. */
export async function DELETE() {
  const guard = await requireRole(['admin']);
  if ('error' in guard) return guard.error;

  const redis = getRedis();
  if (!redis) return NextResponse.json({ error: 'Redis not configured' }, { status: 503 });

  await redis.del(TOKEN_KEY);
  return NextResponse.json({ ok: true });
}
