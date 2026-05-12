-- 0003-drop-messages-deleted-at.sql
-- Removes the soft-delete tombstone column; DELETE /api/messages now hard-deletes.
ALTER TABLE messages DROP COLUMN IF EXISTS deleted_at;
