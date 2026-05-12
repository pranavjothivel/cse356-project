#!/usr/bin/env bash
# Lightweight post-deploy sanity checks. Hits a running target via HTTPS/HTTP
# and the WebSocket upgrade; verifies the user-facing critical paths respond.
#
# Usage:
#   ./smoke-tests/run.sh
#   TARGET=http://localhost:3000 ./smoke-tests/run.sh
#
# Exit code: 0 on full pass, 1 on any failure.

set -u

TARGET="${TARGET:-https://group1.cse356.compas.cs.stonybrook.edu}"
WS_PATH="${WS_PATH:-/api?token=__smoke__}"

# ───── helpers ─────
pass() { printf '  \033[0;32m✓\033[0m %s\n' "$*"; }
fail() { printf '  \033[0;31m✗\033[0m %s\n' "$*"; FAILED=1; }

check_status() {
  # check_status <method> <url> <expected_status> <label>
  local method="$1" url="$2" want="$3" label="$4"
  local got
  got=$(curl -s -o /dev/null -w '%{http_code}' -X "$method" --max-time 10 "$url")
  if [[ "$got" == "$want" ]]; then
    pass "$label ($method $url → $got)"
  else
    fail "$label ($method $url → $got, expected $want)"
  fi
}

# Optional WS upgrade test using python3 (skip if absent).
check_ws_upgrade() {
  local url="$1" label="$2"
  if ! command -v python3 >/dev/null 2>&1; then
    pass "$label (skipped — python3 not available)"
    return
  fi
  local ws_url="${url/https:/wss:}"
  ws_url="${ws_url/http:/ws:}"
  if python3 - "$ws_url" <<'PY' 2>/dev/null; then
import asyncio, ssl, sys
url = sys.argv[1]
try:
    import websockets  # type: ignore
except ImportError:
    sys.exit(2)
async def main():
    try:
        async with websockets.connect(url, open_timeout=5, close_timeout=2, ssl=ssl._create_unverified_context() if url.startswith("wss") else None):
            return
    except Exception:
        sys.exit(1)
asyncio.run(main())
PY
    pass "$label (handshake completed)"
  else
    rc=$?
    if [[ $rc -eq 2 ]]; then
      pass "$label (skipped — websockets python lib not installed)"
    else
      fail "$label (handshake failed)"
    fi
  fi
}

# ───── checks ─────
FAILED=0
echo "Smoke target: $TARGET"

# 1. SPA bundle reachable (LB → Nginx)
check_status GET  "$TARGET/"                 200 "SPA bundle served"

# 2. /me unauthenticated should be 401
check_status GET  "$TARGET/api/me"           401 "API auth-required path returns 401 without session"

# 3. /api/communities is mounted under requireAuth; an unauthenticated hit
#    should yield 401, never 5xx (so this also confirms API-pool routing).
check_status GET  "$TARGET/api/communities"  401 "API pool routing alive"

# 4. Google OAuth redirect leg
check_status GET  "$TARGET/api/auth/google"  302 "Google OAuth redirect"

# 5. WS upgrade ACL routes to WS pool
check_ws_upgrade "$TARGET$WS_PATH"               "WebSocket upgrade routes to WS pool"

# ───── result ─────
echo
if [[ "$FAILED" -eq 0 ]]; then
  echo "✓ all smoke checks passed"
  exit 0
else
  echo "✗ one or more smoke checks failed"
  exit 1
fi
