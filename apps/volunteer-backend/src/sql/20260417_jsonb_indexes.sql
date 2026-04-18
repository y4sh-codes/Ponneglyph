-- Volunteer normalized schema indexes
-- Keeps this script idempotent for environments that run it manually.

CREATE UNIQUE INDEX IF NOT EXISTS idx_volunteer_user_id
  ON volunteer USING btree (user_id);

CREATE INDEX IF NOT EXISTS idx_volunteer_city
  ON volunteer USING btree (city);

CREATE INDEX IF NOT EXISTS idx_volunteer_message_to_user_id
  ON volunteer_message USING btree (to_user_id);

CREATE INDEX IF NOT EXISTS idx_volunteer_message_from_user_id
  ON volunteer_message USING btree (from_user_id);

CREATE INDEX IF NOT EXISTS idx_volunteer_message_status
  ON volunteer_message USING btree (status);

CREATE INDEX IF NOT EXISTS idx_volunteer_connection_user_low_id
  ON volunteer_connection USING btree (user_low_id);

CREATE INDEX IF NOT EXISTS idx_volunteer_connection_user_high_id
  ON volunteer_connection USING btree (user_high_id);

CREATE INDEX IF NOT EXISTS idx_volunteer_engagement_user_id
  ON volunteer_engagement USING btree (user_id);

CREATE INDEX IF NOT EXISTS idx_volunteer_engagement_post_id
  ON volunteer_engagement USING btree (post_id);

CREATE INDEX IF NOT EXISTS idx_volunteer_engagement_topics_gin
  ON volunteer_engagement USING gin (topics);

CREATE INDEX IF NOT EXISTS idx_volunteer_tags_tag_id
  ON volunteer_tags USING btree (tag_id);

CREATE INDEX IF NOT EXISTS idx_volunteer_tags_volunteer_id
  ON volunteer_tags USING btree (volunteer_id);
