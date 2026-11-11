CREATE TABLE IF NOT EXISTS cg_gateway_requests (
  request_id UUID PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES cg_projects(project_id) ON DELETE RESTRICT,
  client_idempotency_key TEXT NOT NULL CHECK (length(client_idempotency_key) BETWEEN 8 AND 128),
  reservation_id UUID NULL UNIQUE REFERENCES cg_reservations(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider IN ('openai','anthropic','google')),
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('STARTED','SUCCEEDED','PROVIDER_ERROR','SUCCESS_USAGE_UNKNOWN','PROVIDER_ERROR_USAGE_UNKNOWN','UNKNOWN','RECONCILIATION_ERROR','POLICY_BLOCKED','RESERVATION_REJECTED')),
  estimated_cost_micros BIGINT NOT NULL CHECK (estimated_cost_micros >= 0),
  actual_cost_micros BIGINT NULL CHECK (actual_cost_micros IS NULL OR actual_cost_micros >= 0),
  input_tokens BIGINT NULL CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens BIGINT NULL CHECK (output_tokens IS NULL OR output_tokens >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cg_gateway_requests_project_idempotency_unique UNIQUE(project_id,client_idempotency_key)
);
CREATE INDEX IF NOT EXISTS cg_gateway_requests_project_time_idx ON cg_gateway_requests(project_id,created_at DESC);
