CREATE TABLE IF NOT EXISTS cg_guard_projects (
  project_id TEXT PRIMARY KEY,
  goal TEXT NOT NULL CHECK (length(goal) > 0),
  state TEXT NOT NULL CHECK (state IN ('CREATED','PLANNING','EXECUTING','VERIFYING','COMPLETED','PAUSED','BLOCKED','FAILED')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cg_project_milestones (
  project_id TEXT NOT NULL REFERENCES cg_guard_projects(project_id) ON DELETE CASCADE,
  milestone_id TEXT NOT NULL,
  title TEXT NOT NULL,
  required BOOLEAN NOT NULL DEFAULT true,
  completed BOOLEAN NOT NULL DEFAULT false,
  completed_at TIMESTAMPTZ NULL,
  PRIMARY KEY(project_id, milestone_id)
);
CREATE TABLE IF NOT EXISTS cg_project_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id TEXT NOT NULL,
  milestone_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('artifact','test','file_change','milestone')),
  reference TEXT NOT NULL,
  verified BOOLEAN NOT NULL DEFAULT false,
  verification_source TEXT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(project_id, milestone_id) REFERENCES cg_project_milestones(project_id, milestone_id) ON DELETE CASCADE,
  CHECK (verified = false OR verification_source IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS cg_project_evidence_lookup_idx ON cg_project_evidence(project_id, milestone_id, recorded_at);

CREATE TABLE IF NOT EXISTS cg_loop_events (
  id BIGSERIAL PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES cg_guard_projects(project_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('request','error','retry','progress')),
  signature TEXT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cg_loop_events_window_idx ON cg_loop_events(project_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS cg_checkpoints (
  checkpoint_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id TEXT NOT NULL REFERENCES cg_guard_projects(project_id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(project_id, version)
);
CREATE INDEX IF NOT EXISTS cg_checkpoints_latest_idx ON cg_checkpoints(project_id, version DESC);
