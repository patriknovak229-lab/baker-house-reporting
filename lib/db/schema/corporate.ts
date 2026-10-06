import {
  pgTable,
  text,
  integer,
  numeric,
  date,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type {
  AgreementStatus,
  BillingCadence,
  PricingMode,
  StayPriceSource,
  StayStatus,
} from '../../../utils/corporateShared';

/**
 * Corporate agreements — a company's standing request for repeated stays, and
 * the dated stays it generates. See utils/corporateShared.ts for the model.
 *
 * WHY THIS IS OUR RECORD AND NOT JUST "SOME BOOKINGS IN BEDS24"
 * -------------------------------------------------------------
 * Beds24 only ever sees the individual bookings. The agreement is what ties
 * ten Monday-night bookings to one company, one price deal, one billing
 * contact and one invoicing rhythm — none of which Beds24 can hold. The stays
 * table is the join: each row is one occurrence of the pattern, with the
 * Beds24 booking id once it exists, and the price we agreed for it frozen at
 * creation (Beds24's own price field is the operator's to edit later).
 *
 * NOT a Redis→Postgres cutover: a new, Postgres-only domain, so no `STORE_*`
 * redis|dual|postgres flag (same as room_moves).
 */
export const corporateAgreements = pgTable(
  'corporate_agreements',
  {
    /** `CA-<base36 ms>-<4 random chars>` — also the value in the Beds24 comment marker. */
    id: text('id').primaryKey(),
    companyName: text('company_name').notNull(),
    companyAddress: text('company_address'),
    ico: text('ico'),
    vatNumber: text('vat_number'),
    billingEmail: text('billing_email'),
    billingCadence: text('billing_cadence').$type<BillingCadence>().notNull().default('per_stay'),
    repName: text('rep_name'),
    repPhone: text('rep_phone'),
    repEmail: text('rep_email'),
    /** Default guest — a stay may override each field. */
    guestFirstName: text('guest_first_name'),
    guestLastName: text('guest_last_name'),
    guestPhone: text('guest_phone'),
    guestEmail: text('guest_email'),
    adults: integer('adults').notNull().default(1),
    children: integer('children').notNull().default(0),
    /** ISO alpha-2, uppercase. Drives `lang` on the Beds24 booking. */
    nationality: text('nationality').notNull().default('CZ'),
    /** Sellable Beds24 room ids the company accepts, in preference order. */
    roomIds: jsonb('room_ids').$type<number[]>().notNull(),
    preferredRoomId: integer('preferred_room_id'),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    /** Last NIGHT, inclusive — see utils/corporateSchedule.ts. */
    endDate: date('end_date', { mode: 'string' }).notNull(),
    /** ISO weekdays 1–7 of the nights slept here. */
    nightWeekdays: jsonb('night_weekdays').$type<number[]>().notNull(),
    pricingMode: text('pricing_mode').$type<PricingMode>().notNull(),
    flatNightPriceCzk: numeric('flat_night_price_czk'),
    discountPercent: numeric('discount_percent').notNull().default('0'),
    notes: text('notes'),
    status: text('status').$type<AgreementStatus>().notNull().default('draft'),
    /** Operator's account email (from the auth guard, never the client). */
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (t) => [index('corporate_agreements_status_idx').on(t.status, t.startDate)],
);

export const corporateStays = pgTable(
  'corporate_stays',
  {
    /** `CS-<agreement suffix>-<seq>` — readable in logs and Telegram. */
    id: text('id').primaryKey(),
    agreementId: text('agreement_id')
      .notNull()
      .references(() => corporateAgreements.id, { onDelete: 'cascade' }),
    /** 1-based position in the generated schedule; stable for the agreement's life. */
    seq: integer('seq').notNull(),
    arrival: date('arrival', { mode: 'string' }).notNull(),
    departure: date('departure', { mode: 'string' }).notNull(),
    nights: integer('nights').notNull(),
    /** Sellable Beds24 room id (type) the stay is booked on. */
    roomId: integer('room_id').notNull(),
    guestFirstName: text('guest_first_name'),
    guestLastName: text('guest_last_name'),
    guestPhone: text('guest_phone'),
    guestEmail: text('guest_email'),
    /** Web price before discount (dynamic mode). */
    listPriceCzk: numeric('list_price_czk'),
    /** Agreed price for this stay, frozen when the booking is created. */
    priceCzk: numeric('price_czk'),
    priceSource: text('price_source').$type<StayPriceSource>(),
    status: text('status').$type<StayStatus>().notNull().default('planned'),
    beds24BookingId: integer('beds24_booking_id'),
    /** "BH-<bookingId>" — joins to Transactions. */
    reservationNumber: text('reservation_number'),
    /** Last Beds24 refusal, kept so the operator can see why and retry. */
    error: text('error'),
    bookedAt: timestamp('booked_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('corporate_stays_agreement_seq_idx').on(t.agreementId, t.seq),
    index('corporate_stays_arrival_idx').on(t.arrival),
    index('corporate_stays_reservation_idx').on(t.reservationNumber),
  ],
);

export type CorporateAgreementRow = typeof corporateAgreements.$inferSelect;
export type CorporateAgreementInsert = typeof corporateAgreements.$inferInsert;
export type CorporateStayRow = typeof corporateStays.$inferSelect;
export type CorporateStayInsert = typeof corporateStays.$inferInsert;
