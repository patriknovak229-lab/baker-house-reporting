CREATE TABLE "corporate_agreements" (
	"id" text PRIMARY KEY NOT NULL,
	"company_name" text NOT NULL,
	"company_address" text,
	"ico" text,
	"vat_number" text,
	"billing_email" text,
	"billing_cadence" text DEFAULT 'per_stay' NOT NULL,
	"rep_name" text,
	"rep_phone" text,
	"rep_email" text,
	"guest_first_name" text,
	"guest_last_name" text,
	"guest_phone" text,
	"guest_email" text,
	"adults" integer DEFAULT 1 NOT NULL,
	"children" integer DEFAULT 0 NOT NULL,
	"nationality" text DEFAULT 'CZ' NOT NULL,
	"room_ids" jsonb NOT NULL,
	"preferred_room_id" integer,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"night_weekdays" jsonb NOT NULL,
	"pricing_mode" text NOT NULL,
	"flat_night_price_czk" numeric,
	"discount_percent" numeric DEFAULT '0' NOT NULL,
	"notes" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "corporate_stays" (
	"id" text PRIMARY KEY NOT NULL,
	"agreement_id" text NOT NULL,
	"seq" integer NOT NULL,
	"arrival" date NOT NULL,
	"departure" date NOT NULL,
	"nights" integer NOT NULL,
	"room_id" integer NOT NULL,
	"guest_first_name" text,
	"guest_last_name" text,
	"guest_phone" text,
	"guest_email" text,
	"list_price_czk" numeric,
	"price_czk" numeric,
	"price_source" text,
	"status" text DEFAULT 'planned' NOT NULL,
	"beds24_booking_id" integer,
	"reservation_number" text,
	"error" text,
	"booked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "corporate_stays" ADD CONSTRAINT "corporate_stays_agreement_id_corporate_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."corporate_agreements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "corporate_agreements_status_idx" ON "corporate_agreements" USING btree ("status","start_date");--> statement-breakpoint
CREATE UNIQUE INDEX "corporate_stays_agreement_seq_idx" ON "corporate_stays" USING btree ("agreement_id","seq");--> statement-breakpoint
CREATE INDEX "corporate_stays_arrival_idx" ON "corporate_stays" USING btree ("arrival");--> statement-breakpoint
CREATE INDEX "corporate_stays_reservation_idx" ON "corporate_stays" USING btree ("reservation_number");