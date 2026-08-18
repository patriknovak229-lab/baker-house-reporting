CREATE TABLE "market_daily" (
	"listing_id" text NOT NULL,
	"stay_date" date NOT NULL,
	"market_occupancy" numeric,
	"market_occupancy_stly" numeric,
	"market_pickup_7" integer,
	"market_cancellations_7" integer,
	"market_supply" integer,
	"market_supply_stly" integer,
	"p25" numeric,
	"p50" numeric,
	"p75" numeric,
	"p90" numeric,
	"median_booked_price" numeric,
	"recommended_price" numeric,
	"live_price" numeric,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_daily_listing_id_stay_date_pk" PRIMARY KEY("listing_id","stay_date")
);
--> statement-breakpoint
CREATE TABLE "market_horizon" (
	"listing_id" text NOT NULL,
	"horizon_days" integer NOT NULL,
	"market_occupancy" numeric,
	"market_adr" numeric,
	"their_own_occupancy" numeric,
	"their_mpi" numeric,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_horizon_listing_id_horizon_days_pk" PRIMARY KEY("listing_id","horizon_days")
);
--> statement-breakpoint
CREATE TABLE "market_monthly" (
	"listing_id" text NOT NULL,
	"month" text NOT NULL,
	"market_booking_window" numeric,
	"market_los" numeric,
	"market_occupancy" numeric,
	"market_adr" numeric,
	"market_pickup_7" integer,
	"market_pickup_7_stly" integer,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_monthly_listing_id_month_pk" PRIMARY KEY("listing_id","month")
);
--> statement-breakpoint
CREATE INDEX "market_daily_stay_date_idx" ON "market_daily" USING btree ("stay_date");