-- Migration 0004: Add plaintext password column
-- Introduced by: "Move to plaintext passwords" (e8b7763)
-- Apply with: psql $DATABASE_URL -f 0004-add-plaintext-password.sql

ALTER TABLE users ADD COLUMN IF NOT EXISTS password VARCHAR(255);
