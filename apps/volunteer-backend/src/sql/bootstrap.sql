CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS volunteer (
  user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  interests jsonb NOT NULL DEFAULT '[]'::jsonb,
  connections jsonb NOT NULL DEFAULT '[]'::jsonb,
  inbox_requests jsonb NOT NULL DEFAULT '[]'::jsonb,
  sent_requests jsonb NOT NULL DEFAULT '[]'::jsonb,
  post_engagement jsonb NOT NULL DEFAULT '{}'::jsonb,
  topic_engagement jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'volunteer'
      AND column_name = 'interests'
      AND data_type <> 'jsonb'
  ) THEN
    ALTER TABLE volunteer
      ALTER COLUMN interests DROP DEFAULT;

    ALTER TABLE volunteer
      ALTER COLUMN interests TYPE jsonb USING to_jsonb(interests);
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'volunteer'
      AND column_name = 'connections'
      AND data_type <> 'jsonb'
  ) THEN
    ALTER TABLE volunteer
      ALTER COLUMN connections DROP DEFAULT;

    ALTER TABLE volunteer
      ALTER COLUMN connections TYPE jsonb USING to_jsonb(connections);
  END IF;
END $$;

ALTER TABLE volunteer ALTER COLUMN interests SET DEFAULT '[]'::jsonb;
ALTER TABLE volunteer ALTER COLUMN connections SET DEFAULT '[]'::jsonb;

ALTER TABLE volunteer DROP COLUMN IF EXISTS phone;
ALTER TABLE volunteer DROP COLUMN IF EXISTS profile_image_key;
ALTER TABLE volunteer DROP COLUMN IF EXISTS profile_image_embedding;

DROP INDEX IF EXISTS volunteer_interests_gin_idx;
DROP INDEX IF EXISTS volunteer_connections_gin_idx;
CREATE INDEX volunteer_interests_gin_idx ON volunteer USING gin (interests);
CREATE INDEX volunteer_connections_gin_idx ON volunteer USING gin (connections);
DROP INDEX IF EXISTS volunteer_image_embedding_idx;

CREATE OR REPLACE FUNCTION set_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_volunteer_updated_at ON volunteer;
CREATE TRIGGER set_volunteer_updated_at
BEFORE UPDATE ON volunteer
FOR EACH ROW
EXECUTE FUNCTION set_updated_at_column();
