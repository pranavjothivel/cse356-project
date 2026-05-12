# DB Maintenance — 2026-04-15

## Incident Summary

Grader reported sustained `sendMessage 403: Not a channel member` errors across multiple communities. Root cause was ~74k phantom user accounts with no community or channel memberships — grader users that were created but failed to join communities (likely during an earlier outage when the `password` column was missing from the DB).

## Root Causes

1. **Missing `password` column** — Commit `e8b7763` added a `password` field to the User model but migration `0004-add-plaintext-password.sql` was not applied to production. All `User` model queries failed until the column was added manually.

2. **Phantom accounts** — During the window when auth was broken, the grader created user accounts but join requests failed. These users accumulated with no memberships and caused 403s when the grader tried to send messages on their behalf.

## Fix

### Migration applied
```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS password VARCHAR(255);
```

### Indexes added (permanent — also benefit live app)
```sql
CREATE INDEX idx_channel_members_user_id ON channel_members(user_id);
CREATE INDEX idx_community_members_user_id ON community_members(user_id);
CREATE INDEX idx_messages_author_id ON messages(author_id);
```
These speed up the `NOT a channel member` membership check on every `sendMessage` request.

### Phantom user cleanup
Stopped HAProxy and PM2 on all nodes to drain connections, then deleted ~74k memberless users:
```sql
DO $$
DECLARE
  deleted int;
  total int := 0;
BEGIN
  LOOP
    DELETE FROM users WHERE id IN (
      SELECT u.id FROM users u
      WHERE NOT EXISTS (SELECT 1 FROM community_members cm WHERE cm.user_id = u.id)
        AND NOT EXISTS (SELECT 1 FROM channel_members chm WHERE chm.user_id = u.id)
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.author_id = u.id)
        AND NOT EXISTS (SELECT 1 FROM communities co WHERE co.owner_id = u.id)
      LIMIT 1000
    );
    GET DIAGNOSTICS deleted = ROW_COUNT;
    total := total + deleted;
    EXIT WHEN deleted = 0;
    RAISE NOTICE 'Batch: % | Total: %', deleted, total;
  END LOOP;
  RAISE NOTICE 'DONE. Total deleted: %', total;
END$$;
```
~49 users with messages or community ownership were intentionally skipped.

## Maintenance Procedure Used

1. `systemctl stop haproxy` on LB (130.245.136.254)
2. `pm2 stop all` on all 4 app nodes
3. `pg_terminate_backend` to drop remaining PgBouncer pool connections
4. Run cleanup query via `psql` directly on PostgreSQL (10.0.1.235:5432, bypassing PgBouncer)
5. `pm2 start all` on all 4 app nodes
6. `systemctl start haproxy` on LB

## Infrastructure Notes

- PostgreSQL is at `10.0.1.235:5432` (private network only)
- PgBouncer runs on each app node at `127.0.0.1:6432` in **transaction** pool mode (50 connections per node)
- To connect directly to PG from app node: `psql "postgresql://cse356:cse356pass@10.0.1.235:5432/cse356?sslmode=disable"`
- HAProxy config: `/etc/haproxy/haproxy.cfg` on LB node — no stats socket configured
- To SSH to DB node: requires jump host + password auth (`root` / see secrets)
