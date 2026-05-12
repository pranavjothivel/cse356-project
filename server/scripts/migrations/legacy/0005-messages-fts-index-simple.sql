-- Migration 0005: Rebuild FTS GIN index on messages.content using the 'simple'
-- text search config so it matches the runtime query expression in
-- server/src/routes/search.js (FTS_CONFIG = 'simple').
--
-- Background: 0002 created the GIN index on to_tsvector('english', content),
-- but the search route queries with 'simple'. Because the planner only uses a
-- functional GIN index when the query expression matches the index expression
-- exactly (regconfig included), every search has been doing a sequential scan
-- of the messages table. Multi-word community-scoped searches time out as a
-- result. See issue #158.
--
-- Apply with (CONCURRENTLY cannot run in a transaction — do not use psql -1):
--   psql "$DATABASE_URL" -f 0005-messages-fts-index-simple.sql
--
-- Both statements are idempotent and safe to re-run.

CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_content_fts_simple_idx
  ON messages USING GIN (to_tsvector('simple', content));

DROP INDEX CONCURRENTLY IF EXISTS messages_content_fts_idx;

-- Rollback (apply only to undo this migration; restores the pre-0005 state,
-- which is the broken-as-discovered state — search will seq-scan again):
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_content_fts_idx
--     ON messages USING GIN (to_tsvector('english', content));
--   DROP INDEX CONCURRENTLY IF EXISTS messages_content_fts_simple_idx;
--
-- For an incident rollback, also revert the corresponding application change
-- on the search.js comment (no behavioral change — comment-only).
