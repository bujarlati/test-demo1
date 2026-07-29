CREATE TABLE IF NOT EXISTS xumo_users (
  id text PRIMARY KEY,
  email text NOT NULL,
  normalized_email text NOT NULL UNIQUE,
  password_salt text NOT NULL,
  password_hash text NOT NULL,
  name text NOT NULL,
  initials text NOT NULL,
  role text NOT NULL CHECK (role IN ('reader', 'admin')),
  active_story_id text,
  default_connection_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS xumo_auth_sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES xumo_users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS xumo_auth_sessions_user_expiry_idx
  ON xumo_auth_sessions (user_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS xumo_stories (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES xumo_users(id) ON DELETE CASCADE,
  title text NOT NULL,
  subtitle text NOT NULL,
  genre text NOT NULL,
  tone text NOT NULL,
  length_label text NOT NULL,
  target_chapter_count integer NOT NULL CHECK (target_chapter_count > 0),
  cover_theme text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'paused', 'completed', 'archived')),
  canon_version integer NOT NULL CHECK (canon_version >= 0),
  latest_excerpt text NOT NULL,
  unread_canon_changes integer NOT NULL DEFAULT 0 CHECK (unread_canon_changes >= 0),
  current_chapter_number integer NOT NULL DEFAULT 0 CHECK (current_chapter_number >= 0),
  current_chapter_title text NOT NULL DEFAULT '',
  chapter_count integer NOT NULL DEFAULT 0 CHECK (chapter_count >= 0),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS xumo_stories_owner_library_idx
  ON xumo_stories (owner_id, updated_at DESC, id DESC)
  WHERE status <> 'archived';

CREATE INDEX IF NOT EXISTS xumo_stories_connection_idx
  ON xumo_stories ((payload ->> 'modelConnectionId'))
  WHERE payload ->> 'modelConnectionId' IS NOT NULL;

CREATE TABLE IF NOT EXISTS xumo_chapters (
  id text PRIMARY KEY,
  story_id text NOT NULL REFERENCES xumo_stories(id) ON DELETE CASCADE,
  chapter_number integer NOT NULL CHECK (chapter_number > 0),
  title text NOT NULL,
  current_revision_id text NOT NULL,
  estimated_minutes integer NOT NULL CHECK (estimated_minutes >= 0),
  has_unread_revision boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (story_id, chapter_number)
);

CREATE INDEX IF NOT EXISTS xumo_chapters_story_order_idx
  ON xumo_chapters (story_id, chapter_number);

CREATE TABLE IF NOT EXISTS xumo_chapter_revisions (
  id text PRIMARY KEY,
  story_id text NOT NULL REFERENCES xumo_stories(id) ON DELETE CASCADE,
  chapter_id text NOT NULL REFERENCES xumo_chapters(id) ON DELETE CASCADE,
  parent_revision_id text,
  title text NOT NULL,
  paragraphs jsonb NOT NULL,
  reason text NOT NULL,
  model_name text NOT NULL,
  prompt_version text NOT NULL,
  branch_id text,
  change_summary text,
  ending_resolution jsonb,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS xumo_chapter_revisions_chapter_history_idx
  ON xumo_chapter_revisions (chapter_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS xumo_chapter_revisions_story_idx
  ON xumo_chapter_revisions (story_id, chapter_id);

CREATE TABLE IF NOT EXISTS xumo_model_connections (
  id text PRIMARY KEY,
  owner_scope text NOT NULL,
  owner_id text,
  status text NOT NULL,
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS xumo_model_connections_owner_idx
  ON xumo_model_connections (owner_scope, owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS xumo_generation_jobs (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  story_id text NOT NULL,
  task text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  payload jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS xumo_generation_jobs_owner_recent_idx
  ON xumo_generation_jobs (owner_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS xumo_generation_jobs_story_recent_idx
  ON xumo_generation_jobs (story_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS xumo_generation_jobs_recent_idx
  ON xumo_generation_jobs (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS xumo_generation_jobs_running_idx
  ON xumo_generation_jobs (status, created_at)
  WHERE status = 'running';

CREATE TABLE IF NOT EXISTS xumo_audit_events (
  id text PRIMARY KEY,
  actor_user_id text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  created_at timestamptz NOT NULL,
  payload jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS xumo_audit_events_actor_recent_idx
  ON xumo_audit_events (actor_user_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS xumo_audit_events_recent_idx
  ON xumo_audit_events (created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS xumo_safety_decisions (
  id text PRIMARY KEY,
  actor_user_id text NOT NULL,
  story_id text,
  created_at timestamptz NOT NULL,
  payload jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS xumo_safety_decisions_story_recent_idx
  ON xumo_safety_decisions (story_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS xumo_safety_decisions_recent_idx
  ON xumo_safety_decisions (created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS xumo_content_reports (
  id text PRIMARY KEY,
  reporter_user_id text NOT NULL,
  story_id text,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  payload jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS xumo_content_reports_reporter_recent_idx
  ON xumo_content_reports (reporter_user_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS xumo_content_reports_status_recent_idx
  ON xumo_content_reports (status, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS xumo_content_reports_recent_idx
  ON xumo_content_reports (updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS xumo_idempotency_keys (
  user_id text NOT NULL,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS xumo_idempotency_keys_recent_idx
  ON xumo_idempotency_keys (created_at DESC);

CREATE TABLE IF NOT EXISTS xumo_story_creation_requests (
  user_id text NOT NULL REFERENCES xumo_users(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  story_id text NOT NULL REFERENCES xumo_stories(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS xumo_story_creation_requests_recent_idx
  ON xumo_story_creation_requests (created_at DESC);

CREATE TABLE IF NOT EXISTS xumo_legacy_imports (
  source_fingerprint text PRIMARY KEY,
  source_path text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  user_count integer NOT NULL,
  story_count integer NOT NULL,
  chapter_count integer NOT NULL,
  revision_count integer NOT NULL
);
