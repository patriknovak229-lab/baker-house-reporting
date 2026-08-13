ALTER TABLE "bookings_mirror" ADD COLUMN "raw" jsonb;--> statement-breakpoint
ALTER TABLE "bookings_mirror" ADD COLUMN "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL;