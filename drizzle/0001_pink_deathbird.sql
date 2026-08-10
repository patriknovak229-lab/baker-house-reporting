CREATE TABLE "vouchers" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"discount_type" text NOT NULL,
	"value" numeric(14, 2) NOT NULL,
	"status" text NOT NULL,
	"reservation_number" text,
	"redeemed_on_reservation_number" text,
	"guest_name" text,
	"guest_email" text,
	"guest_phone" text,
	"expires_at" date NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"used_at" timestamp with time zone
);
