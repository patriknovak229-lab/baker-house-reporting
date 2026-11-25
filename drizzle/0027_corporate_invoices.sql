CREATE TABLE "corporate_invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"agreement_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"period_from" date NOT NULL,
	"period_to" date NOT NULL,
	"billed_month" text,
	"issue_date" date NOT NULL,
	"due_date" date NOT NULL,
	"due_rule" jsonb,
	"include_payment_details" boolean DEFAULT true NOT NULL,
	"invoice_number" text,
	"amount_czk" numeric(12, 2),
	"lines" jsonb,
	"bill_to" jsonb,
	"sent_at" timestamp with time zone,
	"sent_to" text,
	"send_count" integer DEFAULT 0 NOT NULL,
	"paid_at" date,
	"paid_source" text,
	"payment_check_snoozed_until" date,
	"error" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "corporate_invoices" ADD CONSTRAINT "corporate_invoices_agreement_id_corporate_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."corporate_agreements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "corporate_invoices_number_idx" ON "corporate_invoices" USING btree ("invoice_number");--> statement-breakpoint
CREATE INDEX "corporate_invoices_agreement_idx" ON "corporate_invoices" USING btree ("agreement_id","period_from");--> statement-breakpoint
CREATE INDEX "corporate_invoices_status_idx" ON "corporate_invoices" USING btree ("status","issue_date");