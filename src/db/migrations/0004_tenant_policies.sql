-- 0004_tenant_policies.sql
-- Tenant policy configuration for CoStaff / ControlCenter.

CREATE TABLE IF NOT EXISTS tenant_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL,
  product TEXT NOT NULL CHECK (product IN ('bombastic', 'costaff', 'controlcenter')),
  default_mode TEXT NOT NULL DEFAULT 'review_before_run'
    CHECK (default_mode IN ('full_auto', 'review_before_run', 'step_by_step')),
  default_appetite TEXT NOT NULL DEFAULT 'balanced'
    CHECK (default_appetite IN ('strict', 'cautious', 'balanced', 'adventurous')),
  trust_floor REAL NOT NULL DEFAULT 0.5,
  enable_human_review BOOLEAN DEFAULT TRUE,
  sensitive_categories JSONB DEFAULT '[]',
  blocked_skill_slugs JSONB DEFAULT '[]',
  max_concurrent_workflows INTEGER DEFAULT 10,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(tenant_id, product)
);

CREATE INDEX idx_tenant_policies_tenant ON tenant_policies(tenant_id, product);
