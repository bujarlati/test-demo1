-- Forward-only, additive migration. Rollback is performed by disabling the feature flag;
-- the nullable column and publication/progress records are intentionally retained.

ALTER TABLE xumo_users
  ADD COLUMN IF NOT EXISTS public_pen_name text;

ALTER TABLE xumo_users
  ADD CONSTRAINT xumo_users_public_pen_name_check
  CHECK (
    public_pen_name IS NULL
    OR (
      public_pen_name = btrim(public_pen_name)
      AND char_length(public_pen_name) BETWEEN 2 AND 20
      AND public_pen_name !~ '[[:cntrl:]]'
    )
  );

ALTER TABLE xumo_stories
  ADD CONSTRAINT xumo_stories_id_owner_unique UNIQUE (id, owner_id);

CREATE TABLE xumo_story_publications (
  story_id text PRIMARY KEY,
  owner_id text NOT NULL,
  status text NOT NULL CHECK (
    status IN ('active', 'author_unpublished', 'admin_suspended')
  ),
  first_published_at timestamptz NOT NULL,
  status_updated_at timestamptz NOT NULL,
  admin_actor_user_id text REFERENCES xumo_users(id),
  admin_reason text,
  CONSTRAINT xumo_story_publications_story_owner_fk
    FOREIGN KEY (story_id, owner_id)
    REFERENCES xumo_stories(id, owner_id)
    ON DELETE CASCADE,
  CONSTRAINT xumo_story_publications_admin_fields_check
    CHECK (
      (
        status = 'admin_suspended'
        AND admin_actor_user_id IS NOT NULL
        AND admin_reason IS NOT NULL
        AND admin_reason = btrim(admin_reason)
        AND char_length(admin_reason) > 0
      )
      OR (
        status <> 'admin_suspended'
        AND admin_actor_user_id IS NULL
        AND admin_reason IS NULL
      )
    )
);

CREATE INDEX xumo_story_publications_active_idx
  ON xumo_story_publications (story_id)
  WHERE status = 'active';

CREATE TABLE xumo_public_reading_progress (
  reader_user_id text NOT NULL REFERENCES xumo_users(id) ON DELETE CASCADE,
  story_id text NOT NULL REFERENCES xumo_stories(id) ON DELETE CASCADE,
  chapter_id text NOT NULL,
  chapter_number integer NOT NULL CHECK (chapter_number > 0),
  scroll_progress double precision NOT NULL CHECK (
    scroll_progress >= 0 AND scroll_progress <= 1
  ),
  progress_version integer NOT NULL CHECK (progress_version > 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (reader_user_id, story_id)
);

CREATE INDEX xumo_public_reading_progress_recent_idx
  ON xumo_public_reading_progress (reader_user_id, updated_at DESC);
