CREATE TABLE "app_user_changes" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"old_role" text,
	"new_role" text,
	"changed_by" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_users" (
	"email" text PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "app_user_changes_changed_idx" ON "app_user_changes" USING btree ("changed_at");