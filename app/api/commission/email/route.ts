import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import nodemailer from 'nodemailer';
import { requireRole } from '@/utils/authGuard';
import type { CommissionSettlement } from '@/types/commissionSettlement';
import { buildSettlementHTML } from '@/utils/settlementHtml';
import { generatePDF } from '@/utils/pdfGenerate';
import { formatCurrency } from '@/utils/formatters';
import { readAllCommissionSettlements, writeAllCommissionSettlements } from '@/utils/commissionSettlementsStore';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Saved owner emails, keyed by owner name so re-issuing the same owner's units
// pre-fills the address. Shared across all of that owner's apartments.
// (Ancillary pre-fill map — stays in Redis, not a migrated domain.)
const EMAIL_KEY = 'baker:commission-owner-emails';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

// GET /api/commission/email — saved owner-name → email map (for pre-fill).
export async function GET() {
  const guard = await requireRole(['admin', 'super', 'accountant']);
  if ('error' in guard) return guard.error;
  const redis = getRedis();
  if (!redis) return NextResponse.json({});
  const map = (await redis.get<Record<string, string>>(EMAIL_KEY)) ?? {};
  return NextResponse.json(map);
}

// POST /api/commission/email — email the settlement PDF to the owner.
// Body: { settlement, email, saveEmail? }. Optionally persists the address.
export async function POST(req: NextRequest) {
  const guard = await requireRole(['admin', 'super', 'accountant']);
  if ('error' in guard) return guard.error;

  const { settlement, email, saveEmail } = (await req.json()) as {
    settlement: CommissionSettlement;
    email: string;
    saveEmail?: boolean;
  };

  if (!settlement?.unitId || !settlement?.month) {
    return NextResponse.json({ error: 'Invalid settlement' }, { status: 400 });
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: 'A valid email address is required' }, { status: 400 });
  }

  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  if (!smtpUser || !smtpPass) {
    return NextResponse.json({ error: 'SMTP not configured (SMTP_USER / SMTP_PASS missing)' }, { status: 500 });
  }

  try {
    const html = buildSettlementHTML(settlement);
    const pdfBuffer = await generatePDF(html);
    const label = monthLabel(settlement.month);
    const filename = `Settlement_${settlement.unitId.replace(/\./g, '')}_${settlement.month}.pdf`;

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST ?? 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT ?? '587'),
      secure: false,
      auth: { user: smtpUser, pass: smtpPass },
    });

    const from = process.env.SMTP_FROM
      ? `"Baker House Apartments" <${process.env.SMTP_FROM}>`
      : `"Baker House Apartments" <${smtpUser}>`;

    await transporter.sendMail({
      from,
      to: email,
      subject: `Owner settlement — ${settlement.unitId} — ${label}`,
      text:
        `Dear ${settlement.ownerName},\n\n` +
        `Please find attached your owner settlement statement for apartment ${settlement.unitId} for ${label}.\n\n` +
        `Amount payable to you: ${formatCurrency(settlement.payableToOwner)}.\n\n` +
        `Kind regards,\nPatrik & Zuzana\nBaker House Apartments\nhttps://www.bakerhouseapartments.cz`,
      attachments: [{ filename, content: pdfBuffer, contentType: 'application/pdf' }],
    });

    const sentAt = new Date().toISOString();
    let updated: CommissionSettlement | undefined;

    // Stamp the stored settlement so the history shows a "Sent" status.
    const list = await readAllCommissionSettlements();
    const idx = list.findIndex((s) => s.id === settlement.id);
    if (idx !== -1) {
      list[idx] = { ...list[idx], emailedAt: sentAt, emailedTo: email };
      updated = list[idx];
      await writeAllCommissionSettlements(list);
    }

    // Owner-name → email pre-fill map is ancillary — keep it in Redis.
    if (saveEmail) {
      const redis = getRedis();
      if (redis) {
        const map = (await redis.get<Record<string, string>>(EMAIL_KEY)) ?? {};
        map[settlement.ownerName] = email;
        await redis.set(EMAIL_KEY, map);
      }
    }

    return NextResponse.json({ ok: true, savedEmail: saveEmail ? email : undefined, settlement: updated });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Email send failed' },
      { status: 500 },
    );
  }
}
