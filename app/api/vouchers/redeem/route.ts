import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import type { Voucher } from '@/types/voucher';

const KEY = 'baker:vouchers';

// POST /api/vouchers/redeem — public endpoint (no auth)
// Called by rental-site after a successful booking to mark the voucher as used.
// Optionally accepts reservationNumber so the voucher links back to the booking
// in the reporting app's drawer (otherwise it floats unattached in the Vouchers tab).
export async function POST(req: NextRequest) {
  const { code, reservationNumber } = await req.json() as {
    code?: string;
    reservationNumber?: string;
  };

  if (!code?.trim()) {
    return NextResponse.json({ error: 'code is required' }, { status: 400 });
  }

  const redis = new Redis({
    url:   process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });

  const vouchers = await redis.get<Voucher[]>(KEY) ?? [];
  const codeNorm = code.trim().toLowerCase();
  const idx = vouchers.findIndex((v) => v.code.toLowerCase() === codeNorm);

  if (idx === -1) {
    return NextResponse.json({ error: 'Voucher not found' }, { status: 404 });
  }

  if (vouchers[idx].status !== 'issued') {
    return NextResponse.json({ error: `Voucher is ${vouchers[idx].status}` }, { status: 400 });
  }

  // Check expiry
  const today = new Date().toISOString().slice(0, 10);
  if (vouchers[idx].expiresAt < today) {
    return NextResponse.json({ error: 'Voucher has expired' }, { status: 400 });
  }

  vouchers[idx] = {
    ...vouchers[idx],
    status: 'used',
    usedAt: new Date().toISOString(),
    // Preserve any pre-existing reservationNumber (set at creation time for
    // operator-linked vouchers); only fill it from the redeem payload when
    // the field was previously empty (web vouchers redeemed via rental-site).
    ...(!vouchers[idx].reservationNumber && reservationNumber?.trim()
      ? { reservationNumber: reservationNumber.trim() }
      : {}),
  };

  await redis.set(KEY, vouchers);
  return NextResponse.json({ ok: true });
}
