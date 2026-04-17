# Performance Analysis & Fix Proposals

## Issue 1: Connection Pool Saturation Causing Delivery Failures

### Root Cause

The app runs as a monolith — every PM2 worker hosts search, messaging, WebSocket handlers,
and auth together, all sharing a single Sequelize connection pool (`max: 10` in `db.js`).
When search queries are slow (complex permission subqueries across channel membership and
conversation participants), they hold pool connections for their entire duration.
Simultaneously, every message send queries the DB to look up channel/conversation members
for fanout — with no caching, these pile up. Under concurrent load the pool saturates:
message writes queue waiting for a free connection, which surfaces as delivery failures and
increased latency across the board. The async nature of Node.js keeps the event loop alive,
but the shared Postgres pool is what ties all services together.

### Fix 1: Redis Cache for Member Lookups

In `server/src/routes/messages.js`, `getChannelMemberIds` and `getConversationParticipantIds`
(lines 49–63) fire a DB query on every message send, edit, and delete. These are the hottest
paths in the app — every single message write hits them. Cache the results in Redis with a
short TTL and invalidate on join/leave events in `channels.js`, `communities.js`, and
`conversations.js`.

### Fix 2: Separate Connection Pool for Search

In `server/src/routes/search.js`, swap `require('../db')` for a dedicated Sequelize instance
with `pool: { max: 3 }`. Search can never consume more than 3 connections regardless of load,
leaving the main pool untouched for messaging and WS paths. This is an isolated change that
does not touch any other part of the app.

### Fix 3: Statement Timeout on Search

Set `statement_timeout` on the search Sequelize instance via `dialectOptions`. Runaway
queries are killed by Postgres after a fixed deadline and their connection is immediately
returned to the pool, preventing a slow search from holding a connection indefinitely.

### Fix 4: Raise Main Pool Max + FD Limit

Raise `max` in `server/src/db.js` from 10 to ~25. PgBouncer's `default_pool_size` is 50 per
node (`infra/pgbouncer/pgbouncer.ini`), so there is headroom to absorb more concurrent
queries before requests start queuing. Separately, add `ulimit -n 65535` in the deploy
script (`.github/workflows/deploy.yml`) before the PM2 start block to raise the per-process
file descriptor ceiling — each WebSocket connection consumes one fd, and the default soft
limit of 1024 can be reached under moderate concurrent user load.

---

## Issue 2: WebSocket Delivery Timeouts Under Autograder Load

### Context

The autograder spins up multiple client processes, connects them all to the WS server, has
one client send a message, and expects all other clients to receive the corresponding event
within a timeout window. Failures mean one or more clients never received the event.

### Root Cause 1: Cross-Node Fanout is Fire-and-Forget

The app runs across 4 app nodes behind HAProxy. WS clients are distributed across nodes by
the load balancer, so in any autograder run some clients are on a different node than the one
that processed the POST request. The fanout path in `server/src/ws.js` is:

1. `broadcastToUsers` calls `deliverLocal` for clients on the current node
2. `redisClient.publish(...)` delivers to other nodes via Redis pub/sub

The Redis publish is not awaited — it is fire-and-forget. If Redis is slow, or if the
subscriber on a receiving node is backed up, cross-node delivery silently drops. There is no
retry, no acknowledgement, and no error logged. Clients on other nodes simply never receive
the event and the autograder times out waiting for it.

### Root Cause 2: Pool Exhaustion Can Block the Broadcast Entirely

`getChannelMemberIds` and `getConversationParticipantIds` run as DB queries before
`broadcastToUsers` is ever called (`messages.js` lines 198, 226). If the Sequelize pool is
exhausted at the moment a message is sent — which Issue 1 describes as a realistic scenario
under concurrent search load — the member lookup stalls and the entire fanout is delayed or
never fires. Every client, regardless of which node they are on, misses the event.

### Root Cause 3: Stale Connections Accumulate Over Time

Separately from the autograder scenario, the `ws` server never detects when a client's TCP
connection silently dies (network drop, process kill). Dead sockets persist in the `users`
map and broadcasts attempt delivery into them. Over a long test run this accumulates and
inflates fanout work with writes that will never succeed.

### Fix 1: Address Pool Exhaustion (see Issue 1 fixes)

Fixes 1–4 from Issue 1 directly reduce the probability that the member lookup stalls before
`broadcastToUsers` is called. The Redis cache for member lookups (Fix 1) is the most
impactful: it removes the DB roundtrip from the hot path entirely, so the fanout fires
immediately regardless of pool state.

### Root Cause 4: Client-Side Init Race in Autograder

The autograder's `enableRealtime()` resolves when the WebSocket connection opens at the TCP
level, not when the server finishes its async initialization. The server performs several async
steps after the connection is established — JWT verification, a database lookup via
`User.findByPk`, a Redis distributed lock acquisition, and writing the connection into the
`users` map — before sending the raw string frame `"ready"`. Until `"ready"` is sent, the
client is not in the delivery map and will not receive any broadcasts. If the autograder
proceeds to send a message before all clients have received `"ready"`, clients whose init is
still in-flight silently miss the broadcast with no retry. Under concurrent load with many
clients connecting simultaneously, the database pool pressure from overlapping `User.findByPk`
calls widens this init window further, making the race more likely to affect a larger fraction
of clients.

### Fix 3: Await "ready" in the Autograder Client

The autograder client's `enableRealtime()` must not resolve until the raw string frame
`"ready"` is received from the server. A one-time pre-filter should be installed on the raw
WebSocket message event before any frames are dispatched to application callbacks. If the
frame is exactly `"ready"`, the pending Promise resolves and the pre-filter is removed. If the
frame is exactly `"unaway"` (sent before `"ready"` when the server resets away state on
reconnect), local away state should be cleared and the filter should continue waiting. Any
JSON frames arriving before `"ready"` should be queued and replayed after the Promise
resolves. Only after this change can `await Promise.all(clients.map(c => c.enableRealtime()))`
be relied upon as a guarantee that all clients are registered and ready to receive broadcasts.

### Fix 2: WebSocket Heartbeat (Ping/Pong)

The `ws` library has built-in ping/pong support. A periodic interval pings every connected
client; any client that does not respond within a grace period is terminated. When
`ws.terminate()` fires, the existing `close` event handler in `ws.js` runs normally —
Redis presence cleanup, `users`/`connections` map eviction, and `broadcastPresenceChange('offline')`
all execute as usual. No changes to the cleanup logic are needed.

The heartbeat should run on a 30-second interval with a 10-second response window. Each
connection gets an `isAlive` flag: set to `true` on connect and on every `pong` event, set to
`false` at the start of each interval tick. Any connection still `false` at the next tick did
not respond and is terminated. This is the standard solution recommended by the `ws` library
documentation for production use.
