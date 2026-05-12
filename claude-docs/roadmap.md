# Project Roadmap

---

## 1. Migrations
**Swap `sync({ alter: true })` for sequelize-cli**

Currently the app mutates the database schema on startup using Sequelize's `sync({ alter: true })`. This is fine for early development but dangerous in production — it can silently drop columns or fail on ambiguous changes.

The migration to sequelize-cli involves:
- Installing `sequelize-cli` and generating a `migrations/` directory
- Writing explicit `up` and `down` migration files for each table
- Replacing the `sequelize.sync()` call in `app.js` with a startup check (or running migrations as a separate deploy step)

AI handles the boilerplate well here. The judgment call is deciding when to run migrations relative to deploys, and how to handle rollbacks if a migration fails mid-deploy on a live system.

---

## 2. Data Models
**Community, Channel, Membership, Message, DirectConversation, Attachment, ReadState**

Each model needs its schema defined in Sequelize, with associations (e.g. `Community.hasMany(Channel)`, `Message.belongsTo(User)`). This is straightforward but tedious — AI is fast at generating it.

The trickier design decisions:
- How to model private vs. public channel access (membership join table vs. flag on channel)
- DirectConversation participant list (junction table vs. JSONB array)
- ReadState schema — tracking last-read position per user per channel/DM efficiently
- Attachment storage — references to files vs. inline blobs

These decisions affect query complexity and migration difficulty later, so worth getting right upfront.

---

## 3. REST API
**Communities, channels, DMs, messages (CRUD)**

Standard Express routes with auth middleware gating each endpoint. AI generates this quickly against a clear spec.

The judgment calls:
- Pagination strategy for message history (cursor-based vs. offset — cursor is better for infinite scroll but more complex)
- Permission checks (who can post to a private channel they haven't joined, who can see a DM they're not part of)
- Error response consistency across all routes

---

## 4. Real-Time (WebSocket + Redis Pub/Sub)
**WebSocket layer + Redis pub/sub fanout**

Each app node maintains its own set of WebSocket connections. When a message is sent, it needs to reach all connected users — including those connected to *other* nodes. Redis pub/sub is the bridge: the receiving node publishes to Redis, all nodes subscribe, and each fans out to its local connections.

This is where AI is least helpful at runtime. Code generation is fine, but:
- Debugging why a message reached some clients and not others requires tracing live pub/sub traffic
- Connection lifecycle (reconnect logic, heartbeats, detecting stale connections) has subtle edge cases
- Message ordering guarantees depend on how you sequence DB write vs. Redis publish

These require you to observe running behavior and make tradeoff decisions.

---

## 5. Presence
**Activity tracking, Redis state, 4-status logic**

The four statuses (online, idle, away, offline) require:
- Client-side activity detection (mouse/keyboard events) sent over WebSocket
- Server-side Redis state updated per connection
- A background job or TTL-based expiry to transition online → idle after 1 minute of inactivity
- `away` as a user-set override that persists until explicitly cleared

Redis is well-suited here (TTLs, fast reads), but the logic for aggregating presence across multiple connections from the same user (e.g. two browser tabs) needs careful design. AI can implement what you spec, but the edge cases (what happens when the last connection drops while `away` is set?) require deliberate decisions.

---

## 6. Search
**PostgreSQL FTS with GIN index, filters**

PostgreSQL's built-in full-text search (`tsvector`/`tsquery` with a GIN index) avoids the need for Elasticsearch. The implementation involves:
- Adding a `tsvector` column to the messages table, updated via trigger or application code
- A GIN index on that column for fast lookups
- Scoping queries to communities or DMs the user has access to
- Filters: author, time range
- Results sorted newest-first with enough context (channel, timestamp) to jump to the message

AI handles the SQL well. The judgment call is performance — full-text queries against millions of messages with access-control joins can get slow, and you may need to tune indexes or query structure based on observed query plans.

---

## 7. Read State
**Server-side tracking, DM read receipts**

Read state is tracked per-user per-channel/DM, not per-device. The schema is simple (user_id, channel_id, last_read_message_id), but the logic has nuance:
- Updating read state on scroll/view requires debouncing to avoid a DB write per message
- DMs show read receipts (who has read up to where) — requires exposing per-user read positions within DMs but not channels
- Unread counts need to be efficient — querying "messages after last_read_message_id" for every channel on load is expensive without careful indexing

---

## 8. File Attachments
**Image upload/storage (up to 4 per message)**

Each message supports up to 4 image attachments. Decisions needed:
- Storage backend: local disk (simple, not distributed), object storage (S3-compatible, scales across nodes), or database blobs (don't do this)
- Upload flow: direct upload to app server then move to storage, or presigned URLs to upload directly to object storage
- Serving: proxied through the app or direct CDN/object storage URLs
- Validation: file type, size limits, enforcing the 4-attachment cap

For a multi-node deployment, local disk storage won't work — all nodes need access to the same files, so object storage or a shared volume is required.

---

## 9. React SPA
**Barebones UI for testing/interaction**

The frontend doesn't need to be polished — it primarily serves as a way to exercise the API and WebSocket layer manually. Still needs:
- Auth flows (login, OAuth, account settings)
- Community/channel navigation
- Message thread view with infinite scroll
- DM list and conversation view
- Presence indicators
- Search UI

AI generates React components quickly. The main time cost is wiring everything together and debugging state management as features interact.

---

## 10. Deployment
**Nginx LB, PM2 cluster, multi-node Linode setup**

The target architecture:
- 2+ app nodes running PM2 in cluster mode (one process per CPU core)
- Nginx on a dedicated node as load balancer and static file server for the React SPA
- PostgreSQL on its own node
- Redis on its own node

This is where AI is least useful. Deployment involves your specific infrastructure — IP addresses, SSH keys, environment variables, firewall rules, and Linode-specific networking. Errors here are environment-specific and require you to read logs, run commands, and iterate directly.

Key things to get right:
- WebSocket upgrade headers in Nginx config (commonly missed)
- PM2 cluster mode with no sticky sessions (works because all shared state is in Redis/PG)
- Environment variable management across nodes
- Health checks and process restart policies in PM2
