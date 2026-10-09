ALTER TABLE "supplier_invoices" ADD COLUMN "drive_source_file_id" text;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "document_type" text;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "original_invoice_number" text;--> statement-breakpoint
ALTER TABLE "supplier_invoices" ADD COLUMN "related_invoice_id" text;