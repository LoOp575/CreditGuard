CREATE TABLE IF NOT EXISTS cg_approval_requests (
  approval_id UUID PRIMARY KEY,
  project_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('SCOPE_CHANGE','ARCHITECTURE_CHANGE','DESTRUCTIVE_ACTION','PRODUCTION_CHANGE','SPEND_LIMIT','SECURITY_SENSITIVE')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  details TEXT NOT NULL CHECK (length(details) BETWEEN 1 AND 5000),
  scope_fingerprint TEXT NOT NULL CHECK (length(scope_fingerprint) BETWEEN 8 AND 256),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  status TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED','EXPIRED')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ NULL,
  resolution_note TEXT NULL,
  CONSTRAINT cg_approval_project_idempotency_unique UNIQUE(project_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS cg_approval_project_status_idx ON cg_approval_requests(project_id,status,requested_at DESC);
