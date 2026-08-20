CREATE TABLE "room_moves" (
	"id" text PRIMARY KEY NOT NULL,
	"reservation_number" text NOT NULL,
	"guest_name" text,
	"from_room" text NOT NULL,
	"to_room" text NOT NULL,
	"check_in_date" date,
	"check_out_date" date,
	"moved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"moved_by" text NOT NULL,
	"source" text NOT NULL,
	"in_house" boolean DEFAULT false NOT NULL,
	"forced" boolean DEFAULT false NOT NULL,
	"conflicts" jsonb,
	"reason" text,
	"dismissed_at" timestamp with time zone,
	"dismissed_by" text
);
--> statement-breakpoint
CREATE INDEX "room_moves_open_idx" ON "room_moves" USING btree ("dismissed_at","moved_at");