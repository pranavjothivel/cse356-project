-- Enable trigram extension for unicode-safe substring search
-- Allows ILIKE queries to use a GIN index instead of a sequential scan.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Trigram GIN index on message content
CREATE INDEX IF NOT EXISTS messages_content_trgm_idx
  ON messages USING gin (content gin_trgm_ops);
