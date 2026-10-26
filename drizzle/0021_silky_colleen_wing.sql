CREATE TABLE "web_funnel_daily" (
	"day" date NOT NULL,
	"metric" text NOT NULL,
	"value" numeric NOT NULL,
	"copied_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "web_funnel_daily_day_metric_pk" PRIMARY KEY("day","metric")
);
--> statement-breakpoint
CREATE TABLE "web_funnel_searches" (
	"day" date NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"arrival" date NOT NULL,
	"departure" date NOT NULL,
	"nights" integer NOT NULL,
	"adults" integer NOT NULL,
	"children" integer NOT NULL,
	"offers_count" integer NOT NULL,
	"rooms" integer[] NOT NULL,
	"lang" text,
	"copied_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "web_funnel_searches_day_seq_pk" PRIMARY KEY("day","seq")
);
--> statement-breakpoint
CREATE TABLE "web_traffic_daily" (
	"day" date NOT NULL,
	"channel_group" text NOT NULL,
	"source_medium" text NOT NULL,
	"sessions" integer NOT NULL,
	"total_users" integer NOT NULL,
	"purchases" integer NOT NULL,
	"purchase_revenue" numeric NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "web_traffic_daily_day_channel_group_source_medium_pk" PRIMARY KEY("day","channel_group","source_medium")
);
--> statement-breakpoint
CREATE INDEX "web_funnel_searches_arrival_idx" ON "web_funnel_searches" USING btree ("arrival");