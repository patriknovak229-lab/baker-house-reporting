CREATE TABLE "email_send_log" (
	"id" text PRIMARY KEY NOT NULL,
	"reservation_number" text NOT NULL,
	"template_id" text NOT NULL,
	"template_label" text NOT NULL,
	"channel" text,
	"to_address" text NOT NULL,
	"subject" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"sent_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"reservation_number" text NOT NULL,
	"beds24_message_id" bigint NOT NULL,
	"raw_message" text NOT NULL,
	"company_name" text,
	"company_address" text,
	"ico" text,
	"dic" text,
	"email" text,
	"detected_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"processed_at" timestamp with time zone,
	"last_asked_at" timestamp with time zone,
	"asks_count" integer,
	"last_extracted_from_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "auto_reply_edit_log" (
	"hash" text PRIMARY KEY NOT NULL,
	"edited_at" timestamp with time zone,
	"entry" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auto_reply_log" (
	"id" text PRIMARY KEY NOT NULL,
	"decided_at" timestamp with time zone,
	"entry" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_cost_whitelist" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"cost_category" text NOT NULL,
	"counterparty_account" text,
	"variable_symbol" text,
	"counterparty_name_contains" text,
	"amount" numeric(14, 2),
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_categories" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"color" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_whitelist" (
	"id" text PRIMARY KEY NOT NULL,
	"supplier_name" text NOT NULL,
	"supplier_ico" text,
	"category" text NOT NULL,
	"added_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
