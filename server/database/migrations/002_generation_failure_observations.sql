CREATE TABLE IF NOT EXISTS xumo_generation_failure_observations (
  id text PRIMARY KEY,
  job_id text NOT NULL REFERENCES xumo_generation_jobs(id) ON DELETE CASCADE,
  owner_id text NOT NULL REFERENCES xumo_users(id) ON DELETE CASCADE,
  story_id text NOT NULL,
  task text NOT NULL,
  stage text NOT NULL,
  classifier_version text NOT NULL,
  category text NOT NULL,
  reason_code text NOT NULL,
  fingerprint text NOT NULL,
  model text NOT NULL,
  connection_id text NOT NULL,
  prompt_version text NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  terminal boolean NOT NULL,
  retryable boolean NOT NULL,
  latency_ms integer NOT NULL CHECK (latency_ms >= 0),
  tokens integer NOT NULL CHECK (tokens >= 0),
  created_at timestamptz NOT NULL,
  payload jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS xumo_generation_failures_recent_idx
  ON xumo_generation_failure_observations (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS xumo_generation_failures_pattern_idx
  ON xumo_generation_failure_observations (reason_code, stage, model, created_at DESC);

CREATE INDEX IF NOT EXISTS xumo_generation_failures_fingerprint_idx
  ON xumo_generation_failure_observations (fingerprint, created_at DESC);

CREATE INDEX IF NOT EXISTS xumo_generation_failures_owner_idx
  ON xumo_generation_failure_observations (owner_id, created_at DESC);

CREATE INDEX IF NOT EXISTS xumo_generation_failures_terminal_idx
  ON xumo_generation_failure_observations (created_at DESC)
  WHERE terminal = true;
