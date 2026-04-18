CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS volunteer (
  user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  description text,
  city varchar(100),
  past_works text[] NOT NULL DEFAULT '{}'::text[],
  bio text,
  is_open_to_work boolean NOT NULL DEFAULT false,
  wants_to_start_org boolean NOT NULL DEFAULT false,
  wants_to_hire boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE volunteer ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE volunteer ADD COLUMN IF NOT EXISTS city varchar(100);
ALTER TABLE volunteer ADD COLUMN IF NOT EXISTS past_works text[] DEFAULT '{}'::text[];
UPDATE volunteer SET past_works = '{}'::text[] WHERE past_works IS NULL;
ALTER TABLE volunteer ALTER COLUMN past_works SET DEFAULT '{}'::text[];
ALTER TABLE volunteer ALTER COLUMN past_works SET NOT NULL;
ALTER TABLE volunteer ADD COLUMN IF NOT EXISTS bio text;
ALTER TABLE volunteer ADD COLUMN IF NOT EXISTS is_open_to_work boolean NOT NULL DEFAULT false;
ALTER TABLE volunteer ADD COLUMN IF NOT EXISTS wants_to_start_org boolean NOT NULL DEFAULT false;
ALTER TABLE volunteer ADD COLUMN IF NOT EXISTS wants_to_hire boolean NOT NULL DEFAULT false;
ALTER TABLE volunteer ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE volunteer ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE volunteer DROP COLUMN IF EXISTS interests;
ALTER TABLE volunteer DROP COLUMN IF EXISTS connections;
ALTER TABLE volunteer DROP COLUMN IF EXISTS inbox_requests;
ALTER TABLE volunteer DROP COLUMN IF EXISTS sent_requests;
ALTER TABLE volunteer DROP COLUMN IF EXISTS post_engagement;
ALTER TABLE volunteer DROP COLUMN IF EXISTS topic_engagement;
ALTER TABLE volunteer DROP COLUMN IF EXISTS phone;
ALTER TABLE volunteer DROP COLUMN IF EXISTS profile_image_key;
ALTER TABLE volunteer DROP COLUMN IF EXISTS profile_image_embedding;

DROP INDEX IF EXISTS volunteer_interests_gin_idx;
DROP INDEX IF EXISTS volunteer_connections_gin_idx;
DROP INDEX IF EXISTS idx_volunteer_interests;
DROP INDEX IF EXISTS idx_volunteer_connections;
DROP INDEX IF EXISTS idx_volunteer_inbox_requests;
DROP INDEX IF EXISTS idx_volunteer_sent_requests;
DROP INDEX IF EXISTS idx_volunteer_post_engagement;
DROP INDEX IF EXISTS idx_volunteer_topic_engagement;
DROP INDEX IF EXISTS idx_volunteer_pending_inbox;
DROP INDEX IF EXISTS volunteer_image_embedding_idx;

CREATE UNIQUE INDEX IF NOT EXISTS idx_volunteer_user_id ON volunteer(user_id);
CREATE INDEX IF NOT EXISTS idx_volunteer_city ON volunteer(city);

CREATE TABLE IF NOT EXISTS volunteer_message (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  to_user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending',
  message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  CONSTRAINT volunteer_message_status_check CHECK (status IN ('pending', 'accepted', 'rejected')),
  CONSTRAINT volunteer_message_no_self_check CHECK (from_user_id <> to_user_id),
  CONSTRAINT volunteer_message_message_length_check CHECK (message IS NULL OR char_length(message) <= 280)
);

CREATE INDEX IF NOT EXISTS idx_volunteer_message_to_user_id ON volunteer_message(to_user_id);
CREATE INDEX IF NOT EXISTS idx_volunteer_message_from_user_id ON volunteer_message(from_user_id);
CREATE INDEX IF NOT EXISTS idx_volunteer_message_status ON volunteer_message(status);

CREATE TABLE IF NOT EXISTS volunteer_connection (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_low_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  user_high_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  connected_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT volunteer_connection_user_pair_unique UNIQUE (user_low_id, user_high_id),
  CONSTRAINT volunteer_connection_user_order_check CHECK (user_low_id < user_high_id)
);

CREATE INDEX IF NOT EXISTS idx_volunteer_connection_user_low_id ON volunteer_connection(user_low_id);
CREATE INDEX IF NOT EXISTS idx_volunteer_connection_user_high_id ON volunteer_connection(user_high_id);

CREATE TABLE IF NOT EXISTS volunteer_engagement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  post_id text NOT NULL,
  action text NOT NULL,
  topics text[] NOT NULL DEFAULT '{}'::text[],
  engaged_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT volunteer_engagement_action_check CHECK (action IN ('like', 'save', 'open'))
);

CREATE INDEX IF NOT EXISTS idx_volunteer_engagement_user_id ON volunteer_engagement(user_id);
CREATE INDEX IF NOT EXISTS idx_volunteer_engagement_post_id ON volunteer_engagement(post_id);
CREATE INDEX IF NOT EXISTS idx_volunteer_engagement_topics_gin ON volunteer_engagement USING gin (topics);

CREATE TABLE IF NOT EXISTS volunteer_tags (
  volunteer_id text NOT NULL REFERENCES volunteer(user_id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (volunteer_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_volunteer_tags_tag_id ON volunteer_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_volunteer_tags_volunteer_id ON volunteer_tags(volunteer_id);

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
