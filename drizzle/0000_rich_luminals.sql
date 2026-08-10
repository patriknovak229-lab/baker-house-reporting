CREATE TABLE "occupancy_snapshots" (
	"token" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"expires_at" timestamp with time zone,
	"data" jsonb NOT NULL
);
