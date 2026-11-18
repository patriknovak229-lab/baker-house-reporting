CREATE TABLE "scheduled_payment_links" (
	"id" text PRIMARY KEY NOT NULL,
	"reservation_number" text NOT NULL,
	"allocations" jsonb NOT NULL,
	"amount_czk" numeric NOT NULL,
	"description" text NOT NULL,
	"is_main_payment" boolean DEFAULT false NOT NULL,
	"send_date" date NOT NULL,
	"guest_email" text NOT NULL,
	"guest_name" text,
	"guest_phone" text,
	"status" text NOT NULL,
	"payment_id" text,
	"sent_at" timestamp with time zone,
	"reminder_sent_at" timestamp with time zone,
	"alert_reason" text,
	"alert_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"created_by" text
);
--> statement-breakpoint
ALTER TABLE "additional_payments" ADD COLUMN "allocations" jsonb;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD COLUMN "reservation_number" text;