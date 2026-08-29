CREATE TABLE "price_check_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"check_in" date NOT NULL,
	"nights" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_by" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"run_id" text,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "price_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"source" text NOT NULL,
	"unit_id" text NOT NULL,
	"channel" text NOT NULL,
	"check_in" date NOT NULL,
	"nights" integer NOT NULL,
	"lead_days" integer NOT NULL,
	"price" numeric,
	"original_price" numeric,
	"discount_pct" numeric,
	"discounts" jsonb,
	"labels" jsonb,
	"availability" text NOT NULL,
	"expected_price" numeric,
	"captured_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "price_check_requests_status_idx" ON "price_check_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "price_snapshots_run_idx" ON "price_snapshots" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "price_snapshots_series_idx" ON "price_snapshots" USING btree ("unit_id","channel","nights","lead_days","captured_at");--> statement-breakpoint
CREATE INDEX "price_snapshots_captured_idx" ON "price_snapshots" USING btree ("captured_at");