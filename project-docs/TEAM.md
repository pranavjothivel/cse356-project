# Team Process & Contributions

## How the team worked

- **Primary channel: Discord.** A dedicated team server hosted day-to-day discussion — progress check-ins, deadline coordination, design discussion, and issue tracking. Bot integrations posted Sentry alerts and (later) Grafana alerts into the same channels, so the team saw new problems in the same place we discussed them.
- **GitHub** for code review and async work. PRs were the unit of work; issues were used loosely (more often a Discord message escalating into a PR). The git history is the canonical record of who shipped what.
- **Grafana + Sentry** as the operational eye. Sentry was used until its overhead outweighed the value (mid-April); Grafana Alloy + dashboards persisted to the end.
- **Work was distributed by claim**, not assigned. When a deadline or autograder result surfaced a bottleneck, whichever member had the most context volunteered. Hard rolling-deploy / infra work tended to converge on whoever had paged-in production state recently.
- **Deadlines** were tracked against the autograder ranking week-over-week. Each autograder snapshot reset priorities: "what's the binding constraint *now*" drove the next sprint of work. Capacity analyses (e.g. [`claude-docs/peak-capacity-2026-05-04.md`](../claude-docs/peak-capacity-2026-05-04.md)) bracketed each push.

## Contributions

Member entries below pull from a mix of self-reported responsibilities and `git log --author=...` audits. The git query at the bottom of each contributor's section reproduces their commit list.

---

### Pranav Jothivel

**Main responsibilities**
- Infrastructure, CI/CD, load-balancer configuration, multi-node topology
- Production incident response and observability stack
- Sustained performance-tuning work across HAProxy, PostgreSQL, Redis, and PM2

**Major contributions**
- **Foundational features** — Communities + channels (API + UI), read-state for channels and DMs, DM read receipts over WebSocket, OAuth provider linking/unlinking in account settings, FTS jump-to-message in search, MinIO volume + resize pipeline, load-bot backdoor login.
- **Infrastructure** — Stood up the GitHub Actions deploy pipeline with the matrix-on-`nodes.yml` model that the team uses to add/remove nodes. Added the second LB (`group1-lb-02`) with the heavy BBR + sysctl tune. Grew the node inventory from 1 → 8 app nodes including the `WORKER_ROLE=http`-only node (`api-node-http-01`).
- **Observability** — Initial Grafana Alloy + OTel + HAProxy metrics + Sentry integration. Targeted incident-debug instrumentation passes (POST `/api/messages` timing, `deliverLocal`, WS fanout latency, event-loop lag).
- **Incident response** — Diagnosed the 9.7K-504 incident on 2026-04-13 (PG connection pool exhaustion), the community-load timeout (FTS seq-scan + members N+1), the HAProxy drain/reload race in rolling deploy.
- **Performance tuning** — HAProxy: `nbthread 4→16`, `maxconn 8192→32768`, HTTP/2 ALPN, `tune.ssl.lifetime`, `timeout http-keep-alive`. PostgreSQL: pool sizing, `statement_timeout`, GIN `fastupdate=off` for bounded INSERT latency. PgBouncer: install + `default_pool_size` tuning. PM2: `max_memory_restart`, workers-to-`nproc`.
- **Visible tradeoff tracking** — every reverted decision (Axiom, `simple-redis-mutex`, WS pool extension) was explicitly labelled with a revert path or kept as a commented-out fallback in `nodes.yml` per the team's "comment, don't delete" convention.

**Volume**: ~182 commits, 2026-03-26 → 2026-05-12.

Regenerate the raw list:
```bash
git log --all --author='Pranav Jothivel\|44120295' --pretty=format:'%ad|%h|%s' --date=short --no-merges
```

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

**Volume**: ~45 commits, 2026-03-31 → 2026-05-11.

Regenerate the raw list:
```bash
git log --all --author='Christopher Brinker\|ChristopherBrinker' --pretty=format:'%ad|%h|%s' --date=short --no-merges
```

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

**Communication note (Zach's framing, captured verbatim):** "Team communication: primarily through the group Discord server, which was used for tracking progress, managing deadlines, discussing design decisions, and tracking issues. Work was divided into tasks that were distributed amongst the group as needed. Notifications from Sentry and later Grafana were setup to inform the group of new issues as they appeared."

---

## Coordination summary

- **Communication**: Discord (primary), GitHub PRs (code review), Grafana / Sentry alerts (incident detection).
- **Progress tracking**: weekly review of autograder ranking against other groups; per-incident postmortems (e.g. `claude-docs/incident-2026-04-13-504s.md`); capacity analyses written when bottlenecks shifted (`claude-docs/peak-capacity-2026-05-04.md`).
- **Deadlines**: every autograder run was an external deadline; internally each member set their own queue against the next autograder window. The "binding constraint right now" framing kept the team from polishing parts of the system that weren't on the critical path.

If you want member-level git history, the regenerate-commit-list query is in each section above.
