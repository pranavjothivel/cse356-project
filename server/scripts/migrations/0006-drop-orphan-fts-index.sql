-- Migration 0006: Drop orphan FTS GIN index messages_content_fts_idx2.
--
-- Background: 0002 originally created messages_content_fts_idx with the
-- 'english' regconfig. That index is gone (the 'idx2' suffix indicates a
-- numbered duplicate Sequelize-style; the original was dropped at some point
-- outside of any tracked migration). What remained in production as of
-- 2026-04-30 was a manually-created 'simple' index named
-- messages_content_fts_idx2 — undocumented but functioning.
--
-- Migration 0005 added messages_content_fts_simple_idx (also 'simple') as the
-- canonical, migration-documented FTS index. With both present we have ~1.2 GB
-- of redundant index storage and double write amplification on every insert
-- into messages.content. This migration drops the orphan to leave a single
-- FTS index whose definition matches 0005.
--
-- Apply with (CONCURRENTLY cannot run in a transaction):
--   psql "$DATABASE_URL" -f 0006-drop-orphan-fts-index.sql
--
-- Verify after apply:
--   SELECT indexname FROM pg_indexes
--    WHERE tablename = 'messages' AND indexname LIKE 'messages_content_fts%';
--   -- Expect a single row: messages_content_fts_simple_idx

DROP INDEX CONCURRENTLY IF EXISTS messages_content_fts_idx2;

-- Rollback (only if you need to restore the prior state):
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_content_fts_idx2
--     ON messages USING GIN (to_tsvector('simple', content));
-- This rebuilds the orphan; queries continue to use messages_content_fts_simple_idx
-- regardless. Rollback is only useful if 0005's index is later dropped first.
