CREATE TABLE "web_payment_events" (
	"id" text PRIMARY KEY NOT NULL,
	"schedule_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"type" text NOT NULL,
	"actor" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "web_payment_schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"reservation_number" text NOT NULL,
	"booking_ids" jsonb NOT NULL,
	"arrival" date NOT NULL,
	"departure" date NOT NULL,
	"room_label" text,
	"amount_minor" integer NOT NULL,
	"currency" text DEFAULT 'czk' NOT NULL,
	"guest_name" text NOT NULL,
	"guest_email" text NOT NULL,
	"guest_phone" text,
	"lang" text NOT NULL,
	"voucher_code" text,
	"terms_version" text,
	"source" text NOT NULL,
	"livemode" boolean NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"stripe_payment_method_id" text,
	"stripe_setup_intent_id" text,
	"stripe_checkout_session_id" text,
	"card_brand" text,
	"card_last4" text,
	"card_exp_month" integer,
	"card_exp_year" integer,
	"deadline_date" date NOT NULL,
	"reminder_at" timestamp with time zone,
	"attempt1_at" timestamp with time zone NOT NULL,
	"attempt2_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"auto_declines" integer DEFAULT 0 NOT NULL,
	"first_decline_at" timestamp with time zone,
	"last_decline" jsonb,
	"pending_attempt" jsonb,
	"lock_token" text,
	"locked_at" timestamp with time zone,
	"open_link_session_id" text,
	"pay_token" text NOT NULL,
	"no_auto_cancel" boolean DEFAULT false NOT NULL,
	"emails" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"effects" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"alerts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attention" text,
	"attention_detail" text,
	"beds24" jsonb,
	"paid_at" timestamp with time zone,
	"paid_payment_intent_id" text,
	"paid_amount_minor" integer,
	"paid_via" text,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "web_payment_events_schedule_idx" ON "web_payment_events" USING btree ("schedule_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "web_payment_schedules_reservation_uq" ON "web_payment_schedules" USING btree ("reservation_number");--> statement-breakpoint
CREATE UNIQUE INDEX "web_payment_schedules_setup_session_uq" ON "web_payment_schedules" USING btree ("stripe_checkout_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "web_payment_schedules_pay_token_uq" ON "web_payment_schedules" USING btree ("pay_token");--> statement-breakpoint
CREATE INDEX "web_payment_schedules_status_idx" ON "web_payment_schedules" USING btree ("status");