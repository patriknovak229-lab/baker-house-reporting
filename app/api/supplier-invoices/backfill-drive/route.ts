import { NextResponse } from 'next/server';
import { google } from 'googleapis';
import { Redis } from '@upstash/redis';
import { auth } from '@/auth';
import { requireRole } from '@/utils/authGuard';
import { createInvoiceGmailClient, fetchInvoicePdfForMessage } from '@/utils/gmailInvoice';
import { uploadInvoicePdfToDrive } from '@/utils/driveInvoice';
import type { SupplierInvoice } from '@/types/supplierInvoice';

const INVOICES_KEY = 'baker:supplier-invoices';

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

/**
 * POST /api/supplier-invoices/backfill-drive
 * For every saved invoice that has a Gmail message but no Drive copy, re-fetch
 * the PDF from Gmail and upload it to the shared Drive folder. Used to recover
 * invoices whose Drive upload silently failed (e.g. expired Google sign-in).
 */
export async function POST() {
  const guard = await requireRole(['admin']);
  if ('error' in guard) return guard.error;

  const redis = getRedis();
  if (!redis) return NextResponse.json({ error: 'Redis not configured' }, { status: 503 });

  // The admin's own Google session token is used for the Drive upload
  const session = await auth();
  const refreshToken = (session as unknown as Record<string, unknown>)?.refreshToken as string | undefined;
  if (!refreshToken) {
    return NextResponse.json(
      { error: 'No Google refresh token in session. Sign out and sign in again, then retry.' },
      { status: 401 },
    );
  }

  const raw = await redis.get(INVOICES_KEY);
  const invoices = (Array.isArray(raw) ? raw : []) as SupplierInvoice[];
  const targets = invoices.filter((inv) => !inv.driveUrl && inv.gmailMessageId);

  if (targets.length === 0) {
    return NextResponse.json({ scanned: 0, updated: 0, failed: [] });
  }

  // Validate the admin's Drive token once, up front, for a clean error
  const clientId = process.env.AUTH_GOOGLE_ID;
  const clientSecret = process.env.AUTH_GOOGLE_SECRET;
  if (!clientId || !clientSecret) {
    return NextResponse.json({ error: 'Google OAuth credentials not configured' }, { status: 503 });
  }
  const driveAuth = new google.auth.OAuth2(clientId, clientSecret);
  driveAuth.setCredentials({ refresh_token: refreshToken });
  try {
    await driveAuth.getAccessToken();
  } catch {
    return NextResponse.json(
      { error: 'Google Drive sign-in has expired. Sign out and sign in again, then retry.' },
      { status: 401 },
    );
  }
  const drive = google.drive({ version: 'v3', auth: driveAuth });

  // Gmail client for the connected invoice account
  const gmailResult = await createInvoiceGmailClient(redis);
  if ('error' in gmailResult) {
    return NextResponse.json({ error: gmailResult.error }, { status: gmailResult.status });
  }
  const { gmail } = gmailResult;

  let updated = 0;
  const failed: Array<{ id: string; supplierName: string; reason: string }> = [];

  for (const inv of targets) {
    try {
      const pdf = await fetchInvoicePdfForMessage(gmail, inv.gmailMessageId!);
      if (!pdf) {
        failed.push({
          id: inv.id,
          supplierName: inv.supplierName,
          reason: 'No PDF in the Gmail message (a portal download link may have expired).',
        });
        continue;
      }
      const d = await uploadInvoicePdfToDrive(drive, redis, pdf.buffer, {
        supplierName: inv.supplierName,
        invoiceNumber: inv.invoiceNumber,
        amountCZK: inv.amountCZK,
        invoiceDate: inv.invoiceDate,
      });
      // Mutates the object in `invoices` (same reference) so the set() below persists it
      inv.driveFileId = d.fileId;
      inv.driveFileName = d.fileName;
      inv.driveUrl = d.driveUrl;
      updated++;
    } catch (e) {
      failed.push({
        id: inv.id,
        supplierName: inv.supplierName,
        reason: e instanceof Error ? e.message : 'Upload failed',
      });
    }
  }

  if (updated > 0) {
    await redis.set(INVOICES_KEY, invoices);
  }

  return NextResponse.json({ scanned: targets.length, updated, failed });
}
