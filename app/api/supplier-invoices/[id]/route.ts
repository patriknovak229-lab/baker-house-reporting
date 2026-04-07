import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { google } from 'googleapis';
import { auth } from '@/auth';
import { requireRole } from '@/utils/authGuard';
import type { SupplierInvoice } from '@/types/supplierInvoice';

const KEY = 'baker:supplier-invoices';

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireRole(['admin']);
  if ('error' in guard) return guard.error;

  const redis = getRedis();
  if (!redis) return NextResponse.json({ error: 'Redis not configured' }, { status: 503 });

  const { id } = await params;
  const updates = await request.json() as Partial<SupplierInvoice>;

  const raw = await redis.get(KEY);
  const invoices = (Array.isArray(raw) ? raw : []) as SupplierInvoice[];

  const idx = invoices.findIndex((inv) => inv.id === id);
  if (idx === -1) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  invoices[idx] = { ...invoices[idx], ...updates, id };
  await redis.set(KEY, invoices);

  return NextResponse.json(invoices[idx]);
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireRole(['admin']);
  if ('error' in guard) return guard.error;

  const redis = getRedis();
  if (!redis) return NextResponse.json({ error: 'Redis not configured' }, { status: 503 });

  const { id } = await params;

  const raw = await redis.get(KEY);
  const invoices = (Array.isArray(raw) ? raw : []) as SupplierInvoice[];

  const invoice = invoices.find((inv) => inv.id === id);
  if (!invoice) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Delete the PDF from Drive if one exists
  if (invoice.driveFileId) {
    try {
      const session = await auth();
      const s = session as unknown as Record<string, unknown>;
      const refreshToken = s?.refreshToken as string | undefined;
      if (refreshToken) {
        const oauth2 = new google.auth.OAuth2(
          process.env.AUTH_GOOGLE_ID,
          process.env.AUTH_GOOGLE_SECRET,
        );
        oauth2.setCredentials({ refresh_token: refreshToken });
        const { token: freshToken } = await oauth2.getAccessToken();
        if (freshToken) {
          oauth2.setCredentials({ access_token: freshToken });
          const drive = google.drive({ version: 'v3', auth: oauth2 });
          await drive.files.delete({ fileId: invoice.driveFileId });
        }
      }
    } catch (err) {
      // Non-fatal: log but still delete from Redis
      console.error('Drive file deletion failed:', err);
    }
  }

  await redis.set(KEY, invoices.filter((inv) => inv.id !== id));
  return NextResponse.json({ ok: true });
}
