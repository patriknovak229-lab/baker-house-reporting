'use client';
import type { Reservation } from '@/types/reservation';
import PaymentLinkModal from './PaymentLinkModal';
import CreateVoucherModal from './CreateVoucherModal';
import EmailGuestModal from './EmailGuestModal';

/**
 * Forms opened from inside the reservation drawer (Email / WhatsApp / SMS guest,
 * Request payment, Create voucher). They float (components/shared/FloatingPanel),
 * so they're mounted by TransactionsPage rather than the drawer: closing the
 * drawer or opening another reservation must not wipe a half-written message,
 * nor re-point it at a different guest.
 */

export type ReservationFormKind = 'email' | 'whatsapp' | 'sms' | 'payment-link' | 'voucher';

export interface OpenReservationForm {
  kind: ReservationFormKind;
  reservationNumber: string;
  /** The booking as it was when the form opened — used if it drops out of the loaded list. */
  snapshot: Reservation;
}

/** Matches the FloatingPanel id each form gives itself. */
export function reservationFormId(kind: ReservationFormKind, reservationNumber: string): string {
  return `${kind}:${reservationNumber}`;
}

export default function ReservationForm({
  kind,
  reservation,
  onClose,
  onChanged,
}: {
  kind: ReservationFormKind;
  reservation: Reservation;
  onClose: () => void;
  /** Something was created or sent — refresh the data. */
  onChanged: () => void;
}) {
  const guestName = `${reservation.firstName} ${reservation.lastName}`.trim();
  const bestEmail = reservation.additionalEmail || reservation.invoiceData?.billingEmail || undefined;

  switch (kind) {
    case 'payment-link':
      return (
        <PaymentLinkModal
          defaultEmail={bestEmail}
          defaultPhone={reservation.phone}
          defaultAmount={reservation.paymentStatus === 'Partially Paid' ? reservation.price - reservation.amountPaid : undefined}
          defaultDescription={`Baker House — reservation ${reservation.reservationNumber}`}
          reservationNumber={reservation.reservationNumber}
          guestName={guestName}
          onPaymentCreated={onChanged}
          onClose={onClose}
        />
      );
    case 'voucher':
      return (
        <CreateVoucherModal
          reservationNumber={reservation.reservationNumber}
          guestName={guestName}
          guestEmail={bestEmail}
          guestPhone={reservation.phone}
          onVoucherCreated={onChanged}
          onClose={onClose}
        />
      );
    case 'email':
      return (
        <EmailGuestModal
          reservation={reservation}
          channel="email"
          defaultEmail={bestEmail || reservation.email || ''}
          onClose={onClose}
          onSent={() => {
            onClose();
            onChanged();
          }}
        />
      );
    case 'whatsapp':
    case 'sms':
      if (!reservation.phone) return null;
      return (
        <EmailGuestModal
          reservation={reservation}
          channel={kind}
          phone={reservation.phone}
          onClose={onClose}
          onSent={() => {
            onClose();
            onChanged();
          }}
        />
      );
  }
}
