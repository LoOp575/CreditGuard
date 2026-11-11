-- Credit Guard durable ledger. Apply with a migration runner before enabling DATABASE_URL.
CREATE TABLE IF NOT EXISTS cg_projects (
  project_id TEXT PRIMARY KEY,
  budget_micros BIGINT NOT NULL CHECK (budget_micros > 0),
  spent_micros BIGINT NOT NULL DEFAULT 0 CHECK (spent_micros >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cg_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id TEXT NOT NULL REFERENCES cg_projects(project_id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) > 0),
  reserved_micros BIGINT NOT NULL CHECK (reserved_micros > 0),
  actual_micros BIGINT NULL CHECK (actual_micros IS NULL OR actual_micros >= 0),
  status TEXT NOT NULL DEFAULT 'RESERVED' CHECK (status IN ('RESERVED', 'SETTLED', 'RELEASED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at TIMESTAMPTZ NULL,
  CONSTRAINT cg_reservations_project_idempotency_unique UNIQUE (project_id, idempotency_key),
  CONSTRAINT cg_reservations_settlement_consistent CHECK (
    (status = 'SETTLED' AND actual_micros IS NOT NULL AND settled_at IS NOT NULL)
    OR (status <> 'SETTLED' AND actual_micros IS NULL AND settled_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS cg_reservations_project_status_idx
  ON cg_reservations(project_id, status);
