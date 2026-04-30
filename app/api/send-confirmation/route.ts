/**
 * POST /api/send-confirmation
 *
 * Body: { reservation: Reservation, to?: string }
 *
 * Sends a bilingual reservation-confirmation email styled to match the invoice.
 * Picks recipient in this order: explicit `to` → invoiceData.billingEmail →
 * additionalEmail → reservation.email (OTA conduit, only as last resort).
 *
 * From: reservations@bakerhouseapartments.cz alias (the Gmail account doing
 * the sending must have this address configured as a "Send mail as" alias —
 * standard Workspace setup). Override with SMTP_FROM_RESERVATIONS env var if
 * the alias address ever changes.
 */

import { NextRequest, NextResponse } from "next/server";
import nodemailer from "nodemailer";
import { requireRole } from "@/utils/authGuard";
import type { Reservation } from "@/types/reservation";
import {
  buildConfirmationHTML,
  buildConfirmationText,
} from "@/utils/confirmationEmail";

const RESERVATIONS_ALIAS = "reservations@bakerhouseapartments.cz";

/**
 * GET /api/send-confirmation?reservationNumber=BH-12345
 * Renders the same HTML the POST handler would email, so the drawer can
 * preview it in an iframe before the operator commits to sending. Returns
 * raw HTML (Content-Type: text/html) so it works directly in srcDoc.
 *
 * This trusts the POST flow's recipient picking — preview always renders
 * with the live reservation data the client supplies via POST anyway, so
 * we accept the same body payload through GET via JSON in body. Most
 * convenient: callers POST to /api/send-confirmation?preview=1 with the
 * reservation, and we return HTML instead of sending.
 */
async function buildPreview(req: NextRequest): Promise<NextResponse | null> {
  if (req.nextUrl.searchParams.get("preview") !== "1") return null;

  const guard = await requireRole(["admin", "super"]);
  if ("error" in guard) return guard.error;

  let body: { reservation?: Reservation };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.reservation?.reservationNumber) {
    return NextResponse.json({ error: "reservation is required" }, { status: 400 });
  }

  const html = buildConfirmationHTML(body.reservation);
  return new NextResponse(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function pickRecipient(
  reservation: Reservation,
  override?: string,
): string | null {
  const candidates = [
    override,
    reservation.invoiceData?.billingEmail,
    reservation.additionalEmail,
    reservation.email,
  ];
  for (const c of candidates) {
    const trimmed = c?.trim();
    if (trimmed && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return trimmed;
  }
  return null;
}

export async function POST(req: NextRequest) {
  // Preview short-circuit — returns HTML without sending. Same auth + body shape.
  const preview = await buildPreview(req);
  if (preview) return preview;

  const guard = await requireRole(["admin", "super"]);
  if ("error" in guard) return guard.error;

  let body: { reservation?: Reservation; to?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const reservation = body?.reservation;
  if (!reservation || !reservation.reservationNumber) {
    return NextResponse.json({ error: "reservation is required" }, { status: 400 });
  }

  const recipient = pickRecipient(reservation, body?.to);
  if (!recipient) {
    return NextResponse.json(
      { error: "No valid email address found for this reservation" },
      { status: 400 },
    );
  }

  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  if (!smtpUser || !smtpPass) {
    return NextResponse.json(
      { error: "SMTP not configured (SMTP_USER / SMTP_PASS missing)" },
      { status: 500 },
    );
  }

  const fromAddress = process.env.SMTP_FROM_RESERVATIONS ?? RESERVATIONS_ALIAS;
  const from = `"Baker House Apartments" <${fromAddress}>`;

  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST ?? "smtp.gmail.com",
      port: parseInt(process.env.SMTP_PORT ?? "587"),
      secure: false, // STARTTLS on 587
      auth: { user: smtpUser, pass: smtpPass },
    });

    const html = buildConfirmationHTML(reservation);
    const text = buildConfirmationText(reservation);
    const subject = `Reservation Confirmation — ${reservation.reservationNumber} · Baker House Apartments`;

    await transporter.sendMail({
      from,
      to: recipient,
      replyTo: fromAddress,
      subject,
      text,
      html,
    });

    return NextResponse.json({ ok: true, sentTo: recipient });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
