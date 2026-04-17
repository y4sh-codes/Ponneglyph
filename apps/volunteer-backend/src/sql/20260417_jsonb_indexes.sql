-- JSONB performance indexes for volunteer table
-- Adds full-column GIN indexes for containment/key operators and a partial inbox index.

DROP INDEX IF EXISTS volunteer_interests_gin_idx;
DROP INDEX IF EXISTS volunteer_connections_gin_idx;

CREATE INDEX IF NOT EXISTS idx_volunteer_interests
  ON volunteer USING gin (interests);

CREATE INDEX IF NOT EXISTS idx_volunteer_connections
  ON volunteer USING gin (connections);

CREATE INDEX IF NOT EXISTS idx_volunteer_inbox_requests
  ON volunteer USING gin (inbox_requests);

CREATE INDEX IF NOT EXISTS idx_volunteer_sent_requests
  ON volunteer USING gin (sent_requests);

CREATE INDEX IF NOT EXISTS idx_volunteer_post_engagement
  ON volunteer USING gin (post_engagement);

CREATE INDEX IF NOT EXISTS idx_volunteer_topic_engagement
  ON volunteer USING gin (topic_engagement);

CREATE INDEX IF NOT EXISTS idx_volunteer_pending_inbox
  ON volunteer USING gin (inbox_requests)
  WHERE inbox_requests <> '[]'::jsonb;
