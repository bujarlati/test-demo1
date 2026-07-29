-- Forward-only additive migration. Rollback is a later migration that drops the two new tables.
CREATE TABLE IF NOT EXISTS xumo_narration_review_cases (
  id text PRIMARY KEY,
  job_id text NOT NULL REFERENCES xumo_generation_jobs(id) ON DELETE CASCADE,
  owner_id text NOT NULL REFERENCES xumo_users(id) ON DELETE CASCADE,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-fA-F]{64}$'),
  attempt integer NOT NULL CHECK (attempt > 0 AND attempt <= 2),
  rewrite_count integer NOT NULL CHECK (rewrite_count >= 0 AND rewrite_count <= 1),
  status text NOT NULL CHECK (status IN (
    'pending', 'kept', 'rewrite_requested', 'timeout_rewrite', 'resolved', 'failed'
  )),
  version integer NOT NULL CHECK (version > 0),
  deadline_at timestamptz NOT NULL,
  payload_expires_at timestamptz NOT NULL,
  decision_source text CHECK (decision_source IS NULL OR decision_source IN ('user', 'timeout', 'system')),
  candidate_metadata jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(candidate_metadata) = 'array'),
  assessment_metadata jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(assessment_metadata) = 'array'),
  encrypted_payload jsonb,
  created_at timestamptz NOT NULL,
  resolved_at timestamptz,
  CHECK (
    status IN ('resolved', 'failed') OR encrypted_payload IS NOT NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS xumo_narration_review_cases_one_active_job_idx
  ON xumo_narration_review_cases (job_id)
  WHERE status IN ('pending', 'kept', 'rewrite_requested', 'timeout_rewrite');

CREATE INDEX IF NOT EXISTS xumo_narration_review_cases_deadline_idx
  ON xumo_narration_review_cases (status, deadline_at);

CREATE INDEX IF NOT EXISTS xumo_narration_review_cases_payload_expiry_idx
  ON xumo_narration_review_cases (payload_expires_at)
  WHERE encrypted_payload IS NOT NULL;

CREATE INDEX IF NOT EXISTS xumo_narration_review_cases_owner_job_idx
  ON xumo_narration_review_cases (owner_id, job_id, created_at DESC);

CREATE TABLE IF NOT EXISTS xumo_narration_review_feedback (
  id text PRIMARY KEY,
  case_id text REFERENCES xumo_narration_review_cases(id) ON DELETE SET NULL,
  job_id text NOT NULL REFERENCES xumo_generation_jobs(id) ON DELETE CASCADE,
  owner_id text NOT NULL REFERENCES xumo_users(id) ON DELETE CASCADE,
  candidate_id text NOT NULL,
  rule_id text NOT NULL,
  rule_version text NOT NULL,
  location text NOT NULL CHECK (location IN ('title', 'body')),
  model text NOT NULL,
  reported_decision text NOT NULL CHECK (reported_decision IN ('allow', 'rewrite', 'ask_user')),
  decision text NOT NULL CHECK (decision IN ('allow', 'rewrite', 'ask_user')),
  confidence double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  threshold double precision NOT NULL CHECK (threshold >= 0.5 AND threshold <= 0.99),
  resolution_source text NOT NULL CHECK (resolution_source IN ('automatic', 'user', 'timeout', 'system')),
  user_decision text CHECK (user_decision IS NULL OR user_decision IN ('keep', 'rewrite')),
  rewrite_count integer NOT NULL CHECK (rewrite_count >= 0 AND rewrite_count <= 1),
  rewrite_succeeded boolean,
  job_completed boolean,
  latency_ms integer NOT NULL CHECK (latency_ms >= 0),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-fA-F]{64}$'),
  consented_excerpt_ciphertext jsonb,
  excerpt_expires_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (job_id, content_hash, candidate_id),
  CHECK (
    (consented_excerpt_ciphertext IS NULL AND excerpt_expires_at IS NULL) OR
    (consented_excerpt_ciphertext IS NOT NULL AND excerpt_expires_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS xumo_narration_review_feedback_rule_idx
  ON xumo_narration_review_feedback (rule_id, rule_version, created_at DESC);

CREATE INDEX IF NOT EXISTS xumo_narration_review_feedback_excerpt_expiry_idx
  ON xumo_narration_review_feedback (excerpt_expires_at)
  WHERE consented_excerpt_ciphertext IS NOT NULL;
