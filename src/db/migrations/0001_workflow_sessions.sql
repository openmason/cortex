-- 0001_workflow_sessions.sql
-- Core workflow session tracking for Cortex runtime.

CREATE TABLE IF NOT EXISTS workflow_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  product TEXT NOT NULL CHECK (product IN ('bombastic', 'costaff', 'controlcenter')),
  mode TEXT NOT NULL DEFAULT 'review_before_run'
    CHECK (mode IN ('full_auto', 'review_before_run', 'step_by_step')),
  status TEXT NOT NULL DEFAULT 'planning'
    CHECK (status IN (
      'planning', 'paused_for_review', 'running',
      'paused_at_step', 'completed', 'failed', 'timed_out'
    )),
  prompt TEXT NOT NULL,
  plan_json JSONB,
  resume_data JSONB,
  current_step_index SMALLINT DEFAULT 0,
  result JSONB,
  summary TEXT,
  error TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  paused_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_workflow_sessions_tenant ON workflow_sessions(tenant_id, created_at DESC);
CREATE INDEX idx_workflow_sessions_user ON workflow_sessions(user_id, created_at DESC);
CREATE INDEX idx_workflow_sessions_status ON workflow_sessions(status);
CREATE INDEX idx_workflow_sessions_product ON workflow_sessions(product, status);
