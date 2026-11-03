CREATE TABLE "general_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"assignee" text NOT NULL,
	"text" text NOT NULL,
	"due_date" date NOT NULL,
	"created_by" text NOT NULL,
	"created_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"overdue_notified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "team_notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"recipient" text NOT NULL,
	"text" text NOT NULL,
	"created_by" text NOT NULL,
	"created_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_by" text[] DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX "general_tasks_open_idx" ON "general_tasks" USING btree ("resolved_at","due_date");--> statement-breakpoint
CREATE INDEX "team_notifications_created_idx" ON "team_notifications" USING btree ("created_at");