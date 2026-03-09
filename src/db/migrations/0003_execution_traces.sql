-- 0003_execution_traces.sql
-- Full execution traces for Forge distillation.
-- Post-workflow, the trace is evaluated for reusable patterns.

CREATE TABLE IF NOT EXISTS execution_traces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES workflow_sessions(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  product TEXT NOT NULL,
  prompt TEXT NOT NULL,
  plan_json JSONB NOT NULL,
  steps_executed JSONB NOT NULL,
  total_duration_ms INTEGER,
  success BOOLEAN NOT NULL,
  user_modified_plan BOOLEAN DEFAULT FALSE,
  saved_as_skill BOOLEAN DEFAULT FALSE,
  saved_skill_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_traces_tenant ON execution_traces(tenant_id, created_at DESC);
CREATE INDEX idx_traces_saved ON execution_traces(saved_as_skill) WHERE saved_as_skill = TRUE;
CREATE INDEX idx_traces_product ON execution_traces(product, created_at DESC);
CREATE INDEX idx_traces_success ON execution_traces(success, created_at DESC);
