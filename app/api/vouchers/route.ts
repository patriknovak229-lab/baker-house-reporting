import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { auth } from '@/auth';
import { requireRole } from '@/utils/authGuard';
import type { Voucher } from '@/types/voucher';

const KEY = 'baker:vouchers';

function getRedis(): Redis {
  return new Redis({
    url:   process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });
}

// GET /api/vouchers — list all vouchers
export async function GET() {
  const guard = await requireRole(['admin', 'super', 'accountant']);
  if ('error' in guard) return guard.error;

  const redis = getRedis();
  const vouchers = await redis.get<Voucher[]>(KEY) ?? [];
  return NextResponse.json(vouchers);
}

// POST /api/vouchers — create a new voucher
export async function POST(req: NextRequest) {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  const session = await auth();
  const creatorEmail = session?.user?.email ?? 'unknown';

  const body = await req.json();
  const {
    code,
    discountType,
    value,
    reservationNumber,
    guestName,
    guestEmail,
    guestPhone,
  } = body as Partial<Voucher>;

  if (!code?.trim()) {
    return NextResponse.json({ error: 'code is required' }, { status: 400 });
  }
  if (discountType !== 'fixed' && discountType !== 'percentage') {
    return NextResponse.json({ error: 'discountType must be "fixed" or "percentage"' }, { status: 400 });
  }
  if (!value || value <= 0) {
    return NextResponse.json({ error: 'value must be > 0' }, { status: 400 });
  }
  if (discountType === 'percentage' && value > 100) {
    return NextResponse.json({ error: 'percentage value cannot exceed 100' }, { status: 400 });
  }

  const redis = getRedis();
  const existing = await redis.get<Voucher[]>(KEY) ?? [];

  // Check for duplicate code (case-insensitive) among active vouchers
  const codeNorm = code.trim().toLowerCase();
  if (existing.some((v) => v.code.toLowerCase() === codeNorm && v.status !== 'deleted')) {
    return NextResponse.json({ error: 'A voucher with this code already exists' }, { status: 409 });
  }

  const now = new Date();
  const expiresAt = new Date(now);
  expiresAt.setFullYear(expiresAt.getFullYear() + 1);

  const voucher: Voucher = {
    id: crypto.randomUUID(),
    code: code.trim(),
    discountType,
    value,
    status: 'issued',
    reservationNumber: reservationNumber || undefined,
    guestName: guestName || undefined,
    guestEmail: guestEmail || undefined,
    guestPhone: guestPhone || undefined,
    expiresAt: expiresAt.toISOString().slice(0, 10),
    createdAt: now.toISOString(),
    createdBy: creatorEmail,
  };

  await redis.set(KEY, [...existing, voucher]);
  return NextResponse.json(voucher, { status: 201 });
}
