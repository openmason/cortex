CREATE TABLE "execution_traces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"tenant_id" text NOT NULL,
	"product" text NOT NULL,
	"prompt" text NOT NULL,
	"plan_json" jsonb NOT NULL,
	"steps_executed" jsonb NOT NULL,
	"total_duration_ms" integer,
	"success" boolean NOT NULL,
	"user_modified_plan" boolean DEFAULT false,
	"saved_as_skill" boolean DEFAULT false,
	"saved_skill_id" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "tenant_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"product" text NOT NULL,
	"default_mode" text DEFAULT 'review_before_run' NOT NULL,
	"default_appetite" text DEFAULT 'balanced' NOT NULL,
	"trust_floor" real DEFAULT 0.5 NOT NULL,
	"enable_human_review" boolean DEFAULT true,
	"sensitive_categories" jsonb DEFAULT '[]'::jsonb,
	"blocked_skill_slugs" jsonb DEFAULT '[]'::jsonb,
	"max_concurrent_workflows" integer DEFAULT 10,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "workflow_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"product" text NOT NULL,
	"mode" text DEFAULT 'review_before_run' NOT NULL,
	"status" text DEFAULT 'planning' NOT NULL,
	"prompt" text NOT NULL,
	"plan_json" jsonb,
	"resume_data" jsonb,
	"current_step_index" smallint DEFAULT 0,
	"result" jsonb,
	"summary" text,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now(),
	"paused_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "workflow_step_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"step_order" smallint NOT NULL,
	"skill_id" text NOT NULL,
	"skill_slug" text NOT NULL,
	"skill_version" text NOT NULL,
	"execution_layer" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"error" text,
	"duration_ms" integer,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "execution_traces" ADD CONSTRAINT "execution_traces_session_id_workflow_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."workflow_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_step_executions" ADD CONSTRAINT "workflow_step_executions_session_id_workflow_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."workflow_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_traces_tenant" ON "execution_traces" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_traces_saved" ON "execution_traces" USING btree ("saved_as_skill");--> statement-breakpoint
CREATE INDEX "idx_tenant_policies_tenant" ON "tenant_policies" USING btree ("tenant_id","product");--> statement-breakpoint
CREATE INDEX "idx_workflow_sessions_tenant" ON "workflow_sessions" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_workflow_sessions_user" ON "workflow_sessions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_workflow_sessions_status" ON "workflow_sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_step_executions_session" ON "workflow_step_executions" USING btree ("session_id","step_order");--> statement-breakpoint
CREATE INDEX "idx_step_executions_skill" ON "workflow_step_executions" USING btree ("skill_id");