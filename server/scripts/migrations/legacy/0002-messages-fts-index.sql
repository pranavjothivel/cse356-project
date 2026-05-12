-- 0002-messages-fts-index.sql
-- GIN index backing /api/search full-text queries.
--
-- The expression MUST exactly match the to_tsvector() call in
-- server/src/routes/search.js or the planner will fall back to a seq-scan.
-- If you change the regconfig ('english') or expression, update both here
-- and in search.js atomically.
--
-- Safe to re-run (IF NOT EXISTS).
CREATE INDEX IF NOT EXISTS messages_content_fts_idx
  ON messages USING GIN (to_tsvector('english', content));
