import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import type { Voucher } from '@/types/voucher';

const KEY = 'baker:vouchers';

// GET /api/vouchers/validate?code=XXX — public endpoint (no auth)
// Called by rental-site to check if a voucher is valid and return discount info.
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code')?.trim();

  if (!code) {
    return NextResponse.json({ valid: false, reason: 'code is required' }, { status: 400 });
  }

  const redis = new Redis({
    url:   process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });

  const vouchers = await redis.get<Voucher[]>(KEY) ?? [];
  const codeNorm = code.toLowerCase();
  const voucher = vouchers.find((v) => v.code.toLowerCase() === codeNorm);

  if (!voucher) {
    return NextResponse.json({ valid: false, reason: 'Voucher not found' });
  }

  if (voucher.status === 'used') {
    return NextResponse.json({ valid: false, reason: 'Voucher has already been used' });
  }

  if (voucher.status === 'deleted') {
    return NextResponse.json({ valid: false, reason: 'Voucher is no longer valid' });
  }

  // Check expiry
  const today = new Date().toISOString().slice(0, 10);
  if (voucher.expiresAt < today) {
    return NextResponse.json({ valid: false, reason: 'Voucher has expired' });
  }

  return NextResponse.json({
    valid: true,
    discountType: voucher.discountType,
    value: voucher.value,
    code: voucher.code,
  });
}
