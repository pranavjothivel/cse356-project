# Team Process & Contributions

## How the team worked

- **Primary channel: Discord.** A dedicated team server hosted day-to-day discussion — progress check-ins, deadline coordination, design discussion, and issue tracking. Bot integrations posted Sentry alerts and (later) Grafana alerts into the same channels, so the team saw new problems in the same place we discussed them.
- **GitHub** for code review and async work. PRs were the unit of work; issues were used loosely (more often a Discord message escalating into a PR). The git history is the canonical record of who shipped what.
- **Grafana + Sentry** as the operational eye. **Sentry** captured every unhandled exception thrown by an app worker — the stack trace, request context, and triggering user landed in a team Discord channel within seconds, so silent bugs that didn't bubble up as a non-2xx response still surfaced. It was kept on the hot path until its overhead outweighed the value (mid-April), then disabled in the codepath but kept wired for re-enable. **Grafana Cloud** (Loki + Prometheus, fed by Alloy on the telemetry node) and **Axiom** (HAProxy access-log tail via Vector) persisted to the end.
- **Work was distributed by claim**, not assigned. When a deadline or a new bottleneck surfaced, whichever member had the most context volunteered. Hard rolling-deploy / infra work tended to converge on whoever had paged-in production state recently.
- **Deadlines** were structured around 4/13 Go Live and the 4-week Test Traffic Period that followed (the load generator simulating real end-users continuously). Most feature work was completed well before Go Live to leave the Test Traffic Period for chasing bugs that the pre-Live API tests didn't surface under real-world load. Capacity analyses written when bottlenecks shifted bracketed each push.

---

### Pranav Jothivel

**Main responsibilities**
- Foundational infrastructure and CI/CD — stood up the multi-node topology, the matrix-on-`nodes.yml` deploy model, and the majority of the GitHub Actions pipelines the team uses (full deploy, rolling hot-deploy, MinIO volume CI/resize)
- Load-balancer configuration (HAProxy + Nginx) and second LB rollout
- Production incident response and the observability stack (Grafana Cloud, OTel, Axiom, Sentry integration)
- Sustained performance-tuning work across HAProxy, PostgreSQL, Redis, and PM2

**Major contributions**
- **Foundational features** — Communities + channels (API + UI), read-state for channels and DMs, DM read receipts over WebSocket, OAuth provider linking/unlinking in account settings, FTS jump-to-message in search, MinIO volume + resize pipeline, load-generator backdoor login.
- **Foundational infrastructure** — Built out the cluster from the first app node to the final 8-node topology. Authored the matrix-on-`infra/nodes.yml` deploy model and the majority of the GitHub Actions pipelines (`deploy.yml`, `rolling-hot-deploy.yml`, `ci.yml`, MinIO volume CI/resize). Added the second LB (`group1-lb-02`) with the heavy BBR + sysctl tune. Grew the node inventory from 1 → 8 app nodes including the `WORKER_ROLE=http`-only node (`api-node-http-01`).
- **Observability** — Initial Grafana Alloy + OTel + HAProxy metrics + Sentry integration, with Grafana Cloud (Loki for logs, Prometheus/Mimir for metrics) on the receive side and Axiom for HAProxy live access-log streaming via Vector. Targeted incident-debug instrumentation passes (POST `/api/messages` timing, `deliverLocal`, WS fanout latency, event-loop lag).
- **Incident response** — Diagnosed the 9.7K-504 incident on 2026-04-13 (PG connection pool exhaustion), the community-load timeout (FTS seq-scan + members N+1), the HAProxy drain/reload race in rolling deploy.
- **4/15 sendMessage `403` surge** — When a surge of "not a channel member" 403s appeared around 5 AM on 2026-04-15, identified the root cause: `join-community` API calls were returning 500s under load, and the load-generator clients were silently treating those failed joins as successful and then attempting `sendMessage` as a non-member. Led the diagnosis on the course forum thread with the instructor, then shipped a temporary fall-back in the `sendMessage` handler that joined the user to the community if their membership lookup missed, before sending — the 403s stopped within 30 minutes. Once the instructor patched the load generator to surface join errors explicitly, reverted our fall-back; the 403s did not return and the database stopped accumulating orphan-member rows.
- **Performance tuning — WS payload & hot path** — Brought the 5/5–5/6 prod hot-path WS optimizations onto `main` as `4a5ce79`: pre-stringify broadcast payload at the publisher (so it's serialized once, not per-deliverLocal), skip `deliverLocal` on api-only workers (don't iterate an empty `users` Map), chunk per-user fanout on the subscriber path, coalesce `broadcastPresenceChange` per-user with a 250 ms debounce. Also drove the three-pass per-worker pub/sub restructure (`d2059f4` / `a82eba6` / `c16280b`) that decoupled fanout cost from subscriber count.
- **Performance tuning — DB** — Split `server/src/db.js` so search runs on a dedicated Sequelize pool (`80e4d01`), preventing heavy FTS queries from starving the message-send hot path. Pool sizing, `statement_timeout`, GIN `fastupdate=off` for bounded INSERT latency. PgBouncer install + `default_pool_size` tuning.
- **Performance tuning — LB / runtime** — HAProxy: `nbthread 4→16`, `maxconn 8192→32768`, HTTP/2 ALPN, `tune.ssl.lifetime`, `timeout http-keep-alive`. PM2: `max_memory_restart`, workers-to-`nproc`.
- **Visible tradeoff tracking** — every reverted decision (Axiom, `simple-redis-mutex`, WS pool extension) was explicitly labelled with a revert path or kept as a commented-out fallback in `nodes.yml` per the team's "comment, don't delete" convention.

---

### Christopher Brinker

**Main responsibilities**
- Real-time WebSocket layer ownership: presence, broadcast performance, dead-connection handling
- MinIO infrastructure setup and attachment delivery path
- Application-level metrics and the distributed mutex (`simple-redis-mutex`) behavior

**Major contributions**
- **MinIO infrastructure** — Stood up MinIO for attachment storage (`6219da0`, `c353330`), wired it into the upload path, and integrated avatar handling against the same bucket. Image attachments in conversations and messages (`6326074`, `b5b8341`, `f42a069`), and the upload size limit (`abb4c53`).
- **Metrics** — Built the per-node request-rate / response-time metrics surface (`5c381ee`, `c3a0862`), per-handler metrics for the WS message handler (`edb2ad8`), `broadcastToUsers` metrics (`69b401a`), and `p95` estimation on top of the rolling sample (`7c499e6`, `5edf264`).
- **Redis mutex behavior** — Brought in `simple-redis-mutex` for distributed presence locking (`28569ab`, `be9b0ec`), tuned the timeouts + polling interval after the initial integration (`c505c62`), and remembered the mutex release path inside the WS close handler so dead connections couldn't leak locks (`5462f59`).
- **WebSocket performance** — Dead-connection cleanup and ping/pong re-add for liveness detection (`5b16fb9`, `415ac03`, `a6e4b00`), faster `users` map update during connection init (`16b635e`, `5f93895`), base64 buffer instead of plaintext user IDs when publishing fanouts (`b1b8115`), `broadcastToAllConnected` fallback when the audience is extremely large (`bcca636`), removed `getPresenceAudienceUserIds` once presence broadcasts went universal (`9b1bbba`).
- **Caching layer** — Channel membership / membership-check caches on the `POST /api/messages` hot path (`462e0b0`), sent-message cache, `MEMBER_CACHE_TTL` tuning (`bf39bd5`), extended OIDC timeout.
- **Foundational features** — Backend code reorg (`4fc2bce`), frontend auth integration, change-password, presence (single → multi-connection), away messages, avatars, dedicated Redis pub/sub split (`fd6c321`), DB pool size + acquire timeout, `FTS_CONFIG=simple` for search, private-channel invite flow, channel public/private toggle.

---

### Jacky Chen

**Main responsibilities**
- Authentication system (local + OAuth) and search functionality
- File upload and attachment system
- Message-send hot-path optimization and HAProxy CPU tuning

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

**Major contributions**
- **Direct conversations** — Implemented the DM and group-DM subsystem including the participant list, the "leave but conversation survives" lifecycle, and the "everyone leaves → conversation erased" semantics.
- **Real-time messaging** — Co-implemented the WebSocket + Redis pub/sub message delivery layer.
- **Optimization** — Fixed several suboptimal DB queries on the messaging and presence paths, and scoped broadcasts so events only fan out to the WS connections that actually care about them (rather than every connected client).
- **Issue tracking** — Used a mix of GitHub issues, Grafana dashboards, and Discord to identify and triage correctness and performance problems as they appeared.
- **Scaling** — Drove vertical scaling (upsizing existing nodes — e.g. the 2 vCPU → 8 vCPU pass on the app pool) and horizontal scaling (provisioning additional app nodes and distributing traffic across them via HAProxy backend pool changes).

---

## Coordination summary

- **Communication**: Discord (primary), GitHub PRs (code review), Grafana Cloud / Sentry / Axiom alerts (incident detection).
- **Progress tracking**: continuous monitoring of metrics and latencies on the course grading portal alongside our own instrumentation data (Grafana Cloud dashboards fed by Alloy on the telemetry node; HAProxy `/stats`; Axiom for access-log tail). Per-incident postmortems and capacity analyses written when bottlenecks shifted.
- **Deadlines**: the hard deadline was **4/13 "Go Live"**, after which the load generator ran continuously as simulated real end-users for the 4-week **Test Traffic Period**. We finished the majority of feature work well before Go Live so the team could spend the rest of the window catching bugs that the pre-Live API tests didn't reveal under real-world traffic patterns. The "what's the binding constraint right now" framing drove each new round of work during the Test Traffic Period rather than discrete milestone deadlines.
