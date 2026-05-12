# Smoke tests

Lightweight black-box checks that hit a running deployment and verify the critical user-facing paths are alive. Built as a Jest project so the checks live in standard JavaScript test syntax, run from a developer laptop or CI in seconds, and produce normal Jest output that's easy to thread into automation.

## Running

```bash
cd smoke-tests
npm install        # one-time
npm test           # default target: prod LB
```

To point at a different environment:

```bash
TARGET=http://localhost:3000 npm test
WS_PATH='/api?token=foo' npm test
```

Exit code is `0` if every check passes, non-zero otherwise. Failures print a normal Jest diff.

## What gets checked (`smoke.test.js`)

| # | Check | Why |
|---|---|---|
| 1 | `GET /` → `200` | LB → Nginx → SPA bundle path is alive. |
| 2 | `GET /api/auth/me` (unauthenticated) → `401` | Auth middleware mounted; missing-session path returns the documented status. |
| 3 | `GET /api/communities` (unauthenticated) → `401` | API pool routing through HAProxy `/api/*` ACL works. |
| 4 | `GET /api/auth/google` → `302` to `accounts.google.com` | OAuth redirect leg is wired. |
| 5 | WebSocket upgrade against `/api?token=__smoke__` → handshake completes | LB's WS upgrade ACL routes to the WS pool. |

Each check is an independent Jest `test(...)`; one failure doesn't short-circuit the others.

## Authoring more checks

Drop additional `*.test.js` files into this directory. The Jest config (`jest.config.js`) discovers them automatically. Reuse the `TARGET` env var pattern so the same suite can target dev, staging, and prod.
