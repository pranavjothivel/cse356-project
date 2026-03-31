# Architecture & Design Decisions

This document captures the architectural decisions made for the CSE356 messaging system. It is the source of truth for infrastructure and implementation choices.

---

## Project Overview

A cloud-hosted, real-time text messaging app (Discord-like) built for the CSE356 course. The frontend is a barebones React SPA used primarily for API route discovery and manual testing. The backend must handle thousands of concurrent users.

---

## Deployment Topology

```
                        ┌─────────────────────────┐
                        │   Load Balancer (Nginx)  │
                        │   - SSL termination       │
                        │   - Serves React SPA      │
                        │   - Proxies /api & /ws    │
                        └────────────┬────────────┘
                                     │  round-robin
                    ┌────────────────┴────────────────┐
                    ▼                                  ▼
          ┌─────────────────┐              ┌─────────────────┐
          │   App Node 1    │              │   App Node 2    │
          │  Nginx → PM2    │              │  Nginx → PM2    │
          │  (N workers)    │              │  (N workers)    │
          └────────┬────────┘              └────────┬────────┘
                   │                                │
           ┌───────┴───────────────────────────────┘
           │                   │
           ▼                   ▼
  ┌─────────────────┐  ┌─────────────────┐
  │   PostgreSQL    │  │     Redis       │
  │   (dedicated)   │  │   (dedicated)   │
  └─────────────────┘  └─────────────────┘
```

**Nodes:**
| Node | Software | Notes |
|---|---|---|
| Load balancer | Nginx | SSL termination, serves React build, proxies `/api` + `/ws` |
| App node × 2+ | Nginx → PM2 cluster → Node workers | Stateless; all shared state in Redis/PG |
| DB node | PostgreSQL | Single write node; add read replica if needed later |
| Cache node | Redis | Sessions, pub/sub, presence state |

> Redis and PostgreSQL can be colocated on one node to save cost if needed — they don't compete (Redis is memory-bound, PG is disk-bound).

---

## Technology Decisions

| Concern | Decision | Rationale |
|---|---|---|
| Real-time transport | WebSocket (`ws` library) | Full-duplex; chat is bidirectional. Not socket.io — too heavy. |
| Cross-process message fanout | Redis pub/sub | WS connections are per-process; Redis broadcasts across all workers/nodes |
| Session store | Redis (`connect-redis`) | Low-latency, no DB load on every request |
| Presence state | Redis | TTL keys + pub/sub for connection count and last-activity tracking |
| Full-text search | PostgreSQL FTS (GIN index) | Sufficient at this scale; no need for Elasticsearch |
| File/image attachments | NFS shared volume | Mounted at `/mnt/uploads` on all app nodes; Nginx serves files directly. Ceph rejected — requires 3+ nodes for quorum and adds operational overhead not warranted at this scale. |
| Process management | PM2 cluster mode | One worker per vCPU; all coordination via Redis, not shared memory |
| Schema migrations | sequelize-cli | Replaces `sync({ alter: true })` before schema grows |
| Load balancer | Nginx (self-hosted) | Also serves React SPA — HAProxy can't serve static files |
| Frontend | React SPA | Barebones; served from LB node only |

---

## Why No Sticky Sessions

Because Redis holds all shared state (sessions, presence, pub/sub), the load balancer can pure round-robin both HTTP and WebSocket traffic. A WebSocket connection pinned to Node 1 still receives messages published from Node 2 via Redis pub/sub.

---

## Redis Responsibilities

- **Session store** — replaces `connect-pg-simple`
- **Pub/sub bus** — fan out WS messages/events across all workers and nodes
- **Presence state** — hash of `userId → { status, lastActivity, connectionCount }`
- **Unread counts cache** — optional but reduces PG read load

---

## Scalability

- **Adding an app node** — scales linearly for WS connections and HTTP throughput
- **First bottleneck** — PostgreSQL write throughput (message sends, read state updates). Mitigations: `pgBouncer` connection pooler, read replicas for search/history queries
- **Redis** — not a bottleneck until ~100k ops/sec; Redis Cluster available if ever needed
- **Practical ceiling** — ~15k–25k concurrent connected users on 2 × (4GB / 2 vCPU) nodes before hitting PG write limits

---

## Implementation Order

1. **Migrations** — replace `sync({ alter: true })`, define schema foundation
2. **Redis integration** — session store + pub/sub infrastructure  
3. **WebSocket server** — connection manager with Redis fanout
4. **Presence system** — built on WS + Redis (online/idle/away/offline)
5. **Communities & channels** — data model + REST routes
6. **Messaging** — send/edit/delete with real-time WS broadcast
7. **Search** — PG FTS with GIN index, author/time filters
8. **Read state** — per-user tracking, read receipts for DMs
9. **React SPA** — barebones UI wired to all routes

---

## Current State

Auth layer is complete:
- Local accounts (username + password via bcrypt)
- OAuth: Google, GitHub, course OIDC (Keycloak)
- Multi-provider accounts — `User.providers` JSONB array, link/unlink from account settings
- Per-session logout (destroying one session does not affect others)
- Sessions currently stored in PostgreSQL via `connect-pg-simple` — will be moved to Redis

**Not yet built:** communities, channels, DMs, WebSocket server, presence, search, read state, frontend.
