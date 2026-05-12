# Smoke tests

Lightweight black-box checks that hit a running deployment and verify the critical user-facing paths are alive. Designed to be run from a developer laptop against any environment (local dev, prod LB) — not a substitute for a full integration suite, but enough to catch a busted deploy in 5 seconds.

## Running

```bash
# Default target = prod LB
./smoke-tests/run.sh

# Against a local dev backend (Express on :3000 + Vite on :5173)
TARGET=http://localhost:3000 ./smoke-tests/run.sh
```

Exit code is `0` if every check passes, non-zero otherwise. Failures print a one-line summary identifying which check failed.

## What gets checked

| # | Check | Why |
|---|---|---|
| 1 | `GET /` → `200` | LB → Nginx → SPA bundle path is alive. |
| 2 | `GET /api/me` (unauthenticated) → `401` | Auth middleware mounted on the correct prefix; missing-session path returns the documented status. |
| 3 | `GET /api/healthz` (or any cheap `/api/*` route returning JSON) → `200` and `Content-Type: application/json` | API pool routing through HAProxy `/api/*` ACL works. |
| 4 | `GET /api/auth/google` → `302` to `accounts.google.com` | OAuth redirect leg is wired. |
| 5 | WebSocket upgrade against `/api?token=__smoke__` → handshake completes (server closes immediately afterwards, which is fine) | LB's WS upgrade ACL routes to the WS pool. |

The script uses only `curl` (and `python3` for WebSocket — falls back to skipping check 5 if Python is absent), so there's nothing to install.

## Authoring more tests

Drop additional `.sh` scripts into this directory. `run.sh` discovers and runs them in lexical order; each script is expected to be self-contained and to exit non-zero on failure. Common helpers (`fail`, `pass`, `check_status`) live in `run.sh` and are sourceable.
