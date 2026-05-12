# Team Process & Contributions

## How the team worked

- **Primary channel: Discord.** A dedicated team server hosted day-to-day discussion — progress check-ins, deadline coordination, design discussion, and issue tracking. Bot integrations posted Sentry alerts and (later) Grafana alerts into the same channels, so the team saw new problems in the same place we discussed them.
- **GitHub** for code review and async work. PRs were the unit of work; issues were used loosely (more often a Discord message escalating into a PR). The git history is the canonical record of who shipped what.
- **Grafana + Sentry** as the operational eye. **Sentry** captured every unhandled exception thrown by an app worker — the stack trace, request context, and triggering user landed in a team Discord channel within seconds, so silent bugs that didn't bubble up as a non-2xx response still surfaced. It was kept on the hot path until its overhead outweighed the value (mid-April), then disabled in the codepath but kept wired for re-enable. **Grafana Cloud** (Loki + Prometheus, fed by Alloy on the telemetry node) and **Axiom** (HAProxy access-log tail via Vector) persisted to the end.
- **Work was distributed by claim**, not assigned. When a deadline or a new bottleneck surfaced, whichever member had the most context volunteered — or whoever could look at the issue ASAP if context was equal. Hard rolling-deploy / infra work tended to converge on whoever had paged-in production state recently.
- **Deadlines** were structured around two course-defined phases. **Pre-4/13** was the API Tests period and a small-scale **Test Traffic Period** — load-generator-induced traffic was gated on 100% API Tests passing (opt-in). **4/13 → 5/8** was the **Live Period**: same course grading load generator shape as Test Traffic but at much greater scale. Most feature work was completed before 4/13 so the team could spend the Live Period chasing bugs that didn't surface in the lower-volume Test Traffic Period. Capacity analyses written when bottlenecks shifted bracketed each push.

---

### Pranav Jothivel

**Main responsibilities**
- Foundational infrastructure and CI/CD — stood up the multi-node topology, the matrix-on-`nodes.yml` deploy model, and the majority of the GitHub Actions pipelines the team uses (full deploy, rolling hot-deploy, MinIO volume CI/resize)
- Load-balancer configuration (HAProxy + Nginx) and the mid-term LB host migration to a BBR + heavy-sysctl-tuned successor
- Production incident response and the observability stack (Grafana Cloud, OTel, Axiom, Sentry integration)
- Sustained performance-tuning work across HAProxy, PostgreSQL, Redis, and PM2

**Leadership / coordination**
- De-facto infrastructure lead — owned the deploy model and the GHA pipelines from inception through the term, which made him the natural point person whenever a deploy needed unusual handling (rolling hot-deploy of a one-off node, mid-incident LB config push, etc.).
- Lead investigator on the **4/15 sendMessage 403 surge** — drove the diagnosis on the course forum thread with the instructor, shipped the temporary `sendMessage` fall-back, then reverted it once the upstream patch landed. Coordinated the timing with the course-side fix.
- Coordinated the mid-term LB host migration (the BBR + heavy-sysctl-tuned successor) across infra config, deploy pipeline, and HAProxy backend updates.

**Major contributions**
- **Foundational features** — Communities + channels (API + UI), read-state for channels and DMs, DM read receipts over WebSocket, OAuth provider linking/unlinking in account settings, FTS jump-to-message in search, MinIO volume + resize pipeline, secured impersonation endpoint to debug as a user created by the grading infra's load generators.
- **Foundational infrastructure** — Built out the cluster from the first app node to the final 8-node topology. Authored the matrix-on-`infra/nodes.yml` deploy model and the majority of the GitHub Actions pipelines (`deploy.yml`, `rolling-hot-deploy.yml`, `ci.yml`, MinIO volume CI/resize). Drove the mid-term LB migration to a heavily-tuned successor host (BBR + `infra/lb-sysctl-heavy.conf`) after the original LB hit its CPU and tuning ceiling. Grew the node inventory from 1 → 8 app nodes including the `WORKER_ROLE=http`-only node (`api-node-http-01`).
- **Observability** — Initial Grafana Alloy + OTel + HAProxy metrics + Sentry integration, with Grafana Cloud (Loki for logs, Prometheus/Mimir for metrics) on the receive side and Axiom for HAProxy live access-log streaming via Vector. Targeted incident-debug instrumentation passes (POST `/api/messages` timing, `deliverLocal`, WS fanout latency, event-loop lag).
- **Incident response** — Diagnosed the 9.7K-504 incident on 2026-04-13 (PG connection pool exhaustion), the community-load timeout (FTS seq-scan + members N+1), the HAProxy drain/reload race in rolling deploy.
- **4/15 sendMessage `403` surge** — When a surge of "not a channel member" 403s appeared around 5 AM on 2026-04-15, identified the root cause: `join-community` API calls were returning 500s under load, and the **course grading load generator's** clients were silently treating those failed joins as successful and then attempting `sendMessage` as a non-member. Led the diagnosis on the course forum thread with the instructor, then shipped a temporary fall-back in the `sendMessage` handler that joined the user to the community if their membership lookup missed, before sending — the 403s stopped within 30 minutes. Once the instructor patched the grading load generator to surface join errors explicitly, reverted our fall-back; the 403s did not return and the database stopped accumulating orphan-member rows.
- **Performance tuning — WS payload & hot path** — Brought a bundle of late-stage prod hot-path WS optimizations onto `main`: pre-stringify the broadcast payload at the publisher (so it's serialized once and reused, not run through `JSON.stringify` per `deliverLocal` call); skip `deliverLocal` entirely on api-only workers (no sockets, no work); chunk per-user fanout on the subscriber path so a single broadcast can't monopolize the event loop; coalesce `broadcastPresenceChange` per-user with a 250 ms debounce. Also drove the three-pass per-worker pub/sub restructure (subscribe per-worker → presence-aware fanout → drop the legacy `messages` channel + dual-publish shim) that decoupled fanout cost from subscriber count.
- **Performance tuning — DB** — Split `server/src/db.js` so search runs on a dedicated Sequelize pool (`searchSequelize`, separate `max`-sized pool against the same physical DB), preventing heavy FTS queries from starving the message-send hot path. Pool sizing on the main pool, per-pool `statement_timeout`, GIN `fastupdate=off` to bound INSERT latency. PgBouncer install on every app node + `default_pool_size` tuning.
- **Performance tuning — LB / runtime** — HAProxy: `nbthread 4→16`, `maxconn 8192→32768`, HTTP/2 ALPN, `tune.ssl.lifetime`, `timeout http-keep-alive`. PM2: `max_memory_restart`, workers-to-`nproc`. **V8 GC tuning** — added `--max-semi-space-size=8 --max-old-space-size=384` to PM2's `node_args`. The smaller young generation makes scavenges fire ~2× more often but cuts each minor-GC pause roughly in half, so short-lived hot-path allocations (Redis buffers, `JSON.stringify` outputs, promise closures) get reclaimed before they promote — pauses stop showing up as event-loop-lag spikes on the WS workers. The old-space cap leaves headroom under PM2's memory-restart ceiling so full GC fires *before* PM2 kills a worker mid-burst (which on the WS pool means losing all its open sockets). Validated by a dedicated load-generator pass logged in `adhoc-loadgen-reports/2026-05-05-post-gc-tuning.*`.
- **Visible tradeoff tracking** — every reverted decision (Axiom, `simple-redis-mutex`, WS pool extension) was explicitly labelled with a revert path or kept as a commented-out fallback in `nodes.yml` per the team's "comment, don't delete" convention.

---

### Christopher Brinker

**Main responsibilities**
- Real-time WebSocket layer ownership: presence, broadcast performance, dead-connection handling
- MinIO infrastructure setup and attachment delivery path
- Application-level metrics and the distributed mutex (`simple-redis-mutex`) behavior

**Leadership / coordination**
- Owned the real-time WebSocket layer end-to-end — anything that touched the `ws.js` surface (presence, broadcasts, dead-connection cleanup, mutex behavior) went through Chris for review or design input.
- Set up the MinIO attachment infrastructure from scratch and remained the team's point person for storage-layer questions (avatars, image uploads, size limits).
- Built the per-node metrics surface (`GET /api/metrics`) that the rest of the team used during tuning passes — coordination role on what got measured.

**Major contributions**
- **MinIO infrastructure** — Stood up MinIO for attachment storage, wired it into the upload path on the app nodes, and integrated avatar handling against the same bucket. Image attachments in conversations and direct-channel messages with edit + delete support; per-message and per-user upload size limits.
- **Metrics** — Built an in-process per-node request-rate / response-time metrics surface (one rolling counter per route) and a `GET /api/metrics` endpoint that renders it. Per-handler metrics on the WS message handler; instrumented `broadcastToUsers` so per-broadcast cost was visible; added p95 estimation on top of the rolling sample using a last-500-batch average.
- **Redis mutex behavior** — Brought in `simple-redis-mutex` for distributed presence locking when the local-only mutex stopped being safe across the WS pool. Tuned the lock-acquire timeout and the polling interval after the initial integration when contention patterns showed up. Patched the WS `close` handler to always release the per-user lock so a dead connection couldn't leak a held lock that would then block every reconnection for that user.
- **WebSocket liveness — ping/pong + redis-cleanup job** — built the active-liveness mechanism that detects TCP-half-open sockets the server's `close` event never fires for. Each WS worker pings its local connections on a 2-minute interval, sharded across 16 buckets by the first hex character of the connection ID and staggered 7.5 s apart so the pings don't batch into a single tick; on each `pong`, the worker refreshes a per-connection `conns:{connId}` key in Redis with a 240 s TTL. Paired this with an hourly redis-cleanup cron job ([`jobs/redis-cleanup/`](../jobs/redis-cleanup/)) running on the telemetry node that walks every `users:*` key, drops any connection ID whose liveness key has expired, and removes empty `users:*` rows entirely.
- **WebSocket performance** — Faster `users`-map update during connection init so a new socket can receive broadcasts before the rest of init completes. Switched the published-fanout payload from plaintext user IDs to a base64 buffer to shrink the per-publish bytes. Added a `broadcastToAllConnected` fast path that skips the per-recipient lookup when the recipient set is essentially the whole connected population. Removed `getPresenceAudienceUserIds` once presence broadcasts went universal — it was no longer a useful filter.
- **Caching layer** — Channel membership and membership-check caches on the `POST /api/messages` hot path so repeated sends don't re-query Postgres for membership; sent-message cache so reads immediately after a write hit Redis instead of DB; tuning of `MEMBER_CACHE_TTL`; extended the OIDC discovery timeout because the course Keycloak occasionally took longer than the default to respond.
- **Foundational features** — Backend code reorganization into the `server/` layout, frontend auth integration with the React SPA, change-password flow, presence (single connection then multi-connection across devices), away-message support, avatars, splitting cross-node pub/sub onto its own Redis instance, initial DB pool size + `acquire` timeout, switching `FTS_CONFIG=simple` for search, private-channel invite flow, channel public/private toggle.

---

### Jacky Chen

**Main responsibilities**
- Authentication system (local + OAuth) and search functionality
- File upload and attachment system
- Message-send hot-path optimization and HAProxy CPU tuning

**Leadership / coordination**
- Owned the user-facing core surface — authentication, attachments, search — the three subsystems that every user interacts with in the first thirty seconds of using the app.
- Coordinated the message-send hot-path performance work with the WS layer (Chris) and the DB layer (Pranav), since the eliminate-re-fetch + async-broadcast + member-cache changes had to fit together to be useful.
- Drove the HAProxy CPU tuning pass; coordinated with Pranav (who owned the higher-level HAProxy config) on which parameters to land in `infra/haproxy/haproxy.cfg`.

**Major contributions**
- **Authentication** — Implemented the local-account + OAuth (Google, GitHub, course OIDC) flow including multi-provider account linking, the `req.session.pendingOAuth` "link-or-create" UX, and the `/auth/oauth-connect` frontend page.
- **Search** — Built the PostgreSQL FTS-based search; experimented with trigram `ILIKE` as an alternative before settling on FTS for the production path.
- **File upload + attachments** — End-to-end attachment system: the upload route, MinIO write path, attachments DB schema, and the 4-attachments-per-message constraint surfaced through the UI.
- **Message-send hot path** — Eliminated the re-fetch after `Message.create()`, moved the broadcast publish to *after* the response is returned (so the publish is async and never blocks the writer), and added Redis member caching for channel/conversation lookups in the broadcast fanout.
- **HAProxy tuning** — Specifically the CPU-side: SSL session caching, HTTP/2 ALPN, threading parameters, and HTTP connection-reuse settings. Backed by measurable HAProxy CPU drops.
- **Postgres / Sequelize** — Pool sizing changes and `acquire` timeout tuning that paired with PgBouncer to remove DB-side contention.

---

### Zach Decena

**Main responsibilities**
- Direct conversations (one-to-one and group DMs)
- Cross-cutting messaging and presence optimization
- Issue tracking and capacity scaling (vertical + horizontal)

**Leadership / coordination**
- Owned the direct-conversation subsystem end-to-end — DM and group-DM data model, participant lifecycle (leave-but-conversation-survives + erase-when-empty), and the read-receipt UX.
- De-facto issue-tracking lead — kept GitHub issues, Grafana alerts, and Discord threads cross-referenced so a single problem didn't get diagnosed twice from different angles.
- Drove the capacity-scaling decisions: which nodes to vertically resize, when to add a new app node, how to redistribute traffic via HAProxy backend pool changes.

**Major contributions**
- **Direct conversations** — Implemented the DM and group-DM subsystem including the participant list, the "leave but conversation survives" lifecycle, and the "everyone leaves → conversation erased" semantics.
- **Real-time messaging** — Co-implemented the WebSocket + Redis pub/sub message delivery layer.
- **Optimization** — Fixed several suboptimal DB queries on the messaging and presence paths, and scoped broadcasts so events only fan out to the WS connections that actually care about them (rather than every connected client).
- **Issue tracking** — Used a mix of GitHub issues, Grafana dashboards, and Discord to identify and triage correctness and performance problems as they appeared.
- **Scaling** — Drove vertical scaling (upsizing existing nodes — e.g. the 2 vCPU → 8 vCPU pass on the app pool) and horizontal scaling (provisioning additional app nodes and distributing traffic across them via HAProxy backend pool changes).

---

## Coordination summary

- **Communication**: Discord (primary), GitHub PRs (code review), Grafana Cloud / Sentry / Axiom alerts (incident detection).
- **Progress tracking**: continuous monitoring of metrics and latencies on the course grading portal alongside our own instrumentation data (Grafana Cloud dashboards fed by Alloy on the telemetry node; HAProxy `/stats`; Axiom for access-log tail). Per-incident write-ups and capacity-analysis documents drafted whenever bottlenecks shifted.
- **Deadlines**: two course phases. **Pre-4/13** — API Tests + a small-scale **Test Traffic Period** where load-generator-induced traffic required 100% API Tests passing to opt-in. **4/13 → 5/8** — the **Live Period**, the same course grading load generator shape as Test Traffic but at much greater scale. The team finished the majority of feature work before 4/13 so the Live Period could be spent chasing bugs that didn't surface at Test Traffic volume. The "what's the binding constraint right now" framing drove each new round of work during the Live Period rather than discrete milestone deadlines.
