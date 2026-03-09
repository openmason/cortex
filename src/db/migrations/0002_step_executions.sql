-- 0002_step_executions.sql
-- Individual step execution records within a workflow.

CREATE TABLE IF NOT EXISTS workflow_step_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES workflow_sessions(id) ON DELETE CASCADE,
  step_order SMALLINT NOT NULL,
  skill_id TEXT NOT NULL,
  skill_slug TEXT NOT NULL,
  skill_version TEXT NOT NULL,
  execution_layer TEXT NOT NULL
    CHECK (execution_layer IN ('mcp-remote', 'instructions', 'worker', 'container', 'composite')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped', 'paused')),
  input JSONB,
  output JSONB,
  error TEXT,
  duration_ms INTEGER,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_step_executions_session ON workflow_step_executions(session_id, step_order);
CREATE INDEX idx_step_executions_skill ON workflow_step_executions(skill_id);
CREATE INDEX idx_step_executions_layer ON workflow_step_executions(execution_layer, status);
