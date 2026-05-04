# Slow Query: Community Unread-Channels — 2026-05-04

How the `GET /api/communities/:id` unread-check query is contributing to delivery P95, and the fix options.

## Symptom

Users see slow community/channel page loads. Delivery P95 (`POST /api/messages` end-to-end) hovers at 1-3K ms even after this session's other fixes (Redis multi-client split, GIN `fastupdate=off`, WAL volume, deserializeUser cache, etc).

## Root cause

`server/src/routes/communities.js:132-152` runs this query on every `GET /api/communities/:id`:

```sql
SELECT cm.channel_id
FROM channel_members cm
LEFT JOIN messages lr ON lr.id = cm.last_read_message_id
WHERE cm.channel_id IN (:channelIds)
  AND cm.user_id = :userId
  AND EXISTS (
    SELECT 1 FROM messages m
    WHERE m.channel_id = cm.channel_id
      AND (lr.id IS NULL OR (m.created_at, m.id) > (lr.created_at, lr.id))
  )
```

Top of `pg_stat_statements` by mean (live):

| Variant | mean | max | calls |
|---|---|---|---|
| 1 channel ID | **3121 ms** | 8817 ms | 4 |
| 2 channel IDs | 2181 ms | 5367 ms | 4 |
| 6 channel IDs | 489 ms | 1158 ms | 3 |
| 11 channel IDs | 466 ms | 466 ms | 1 |
| 14 channel IDs | 457 ms | 457 ms | 1 |

Three structural problems with the query:
1. **EXISTS runs once per channel the user is in** — N-fanout per request.
2. **Tuple comparison `(m.created_at, m.id) > (lr.created_at, lr.id)`** doesn't always plan well; the existing `(channel_id, created_at)` index has `id` only via heap TID, not as a key column.
3. **`lr.id IS NULL OR ...`** OR can defeat index plans entirely.

## Why this affects delivery P95

The query holds a Sequelize main-pool connection slot for its full duration. Under autograder load:
- 3 s × ~5 community loads/s ≈ **15 connection-seconds/sec** consumed by this one query
- `pool.max = 20` per worker → a single user opening community pages can starve the pool for *everyone else on that worker*, including `Message.create` on the delivery hot path
- This is the same cascade pattern we fixed for `passport.deserializeUser` earlier today — different query, identical impact mechanism

## Fix options (smallest → largest)

### Option 1 — Redis cache (recommended)

Cache the unread set per user with a short TTL.

- Key: `unread:${userId}:${communityId}`
- Value: JSON array of unread channel IDs
- TTL: 30 s
- Invalidation: on `Message.create()` to a channel, invalidate the cache for every user in `channel_members` (we already iterate them for the broadcast — same loop). On read-receipt update for a user/channel, invalidate that user's entry for the owning community.

**Pros:** smallest change. Cuts the cold-load DB cost by ~95% in the typical case. Frees pool slots for `Message.create`.

**Cons:** mild cache-coherence complexity. Stale-data window bounded by TTL or until next mutation, whichever first.

### Option 2 — Denormalize and rewrite

Add `last_message_at` to `channels` (updated on every `Message.create()` via a fast single-row UPDATE) and infer `last_read_at` for the user-channel pair via JOIN on `last_read_message_id`. Then the query simplifies to:

```sql
SELECT id FROM channels c
JOIN channel_members cm ON cm.channel_id = c.id
LEFT JOIN messages lr ON lr.id = cm.last_read_message_id
WHERE cm.user_id = $1 AND c.id = ANY($2)
  AND (lr.id IS NULL OR c.last_message_at > lr.created_at)
```

No EXISTS, no tuple comparison, single index scan.

**Pros:** durable; no caching layer.

**Cons:** schema migration, write amplification on every message-create (a UPDATE channels set last_message_at on top of the INSERT messages).

### Option 3 — Move off the request path

Drop server-side unread computation from `GET /api/communities/:id` entirely. Return `last_message_at` per channel + the user's `last_read_message_id`'s timestamp. Let the client compute unread (it already receives `channel.unread` via WS for live updates).

**Pros:** zero DB cost on community load for unread.

**Cons:** API behavior change; client work; requires denormalized `last_message_at` on channels (same as Option 2).

## Defensive backstop: separate Sequelize pool

Independent of the fix above, the architecture would benefit from isolating known-slow queries onto their own constrained pool — same pattern as `searchSequelize` (`server/src/db.js:17-22`) which gives FTS its own `max=6` pool so it can't starve the main pool. The unread query (and any other multi-second SELECT) could be moved to a similar `unreadSequelize` with `max=2-3`. Even if it goes slow, it can't starve `Message.create()`.

This is a "defense in depth" measure, not the primary fix. The primary fix is making the slow query fast. We can do both.

## Other slow paths flagged by `pg_stat_statements` (for follow-up)

| Query | Mean | Source |
|---|---|---|
| Community SELECT with owner JOIN | 467 ms | Sequelize-generated; likely chatty `include` plan |
| Bulk `INSERT INTO channel_members` (community join) | 1.6 s | Once-per-join; lower priority |
| FTS message search | 547 ms | Search hot path; `searchSequelize` already isolates it |

## Decision

Going with **Option 1** (Redis cache) as the immediate fix once the in-flight Redis multi-client PR (#169) lands. Will revisit Option 2/3 if Option 1 doesn't bring delivery P95 below the 750 ms target.
