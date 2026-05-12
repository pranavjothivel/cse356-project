#!/usr/bin/env bash
# TLS handshake latency probe.
#
# Run from an EXTERNAL VM (not one of our cluster nodes) toward the HAProxy LB.
# Each iteration opens a fresh TCP+TLS connection (Connection: close, no reuse)
# and a single GET /. We don't care about response timing — we're hunting for
# massive outliers in dns/tcp/tls phases that could explain the gap between
# our internal p95 (~127ms) and the grader's p95 (1000-3000ms).
#
# Usage:
#   ./tls-probe.sh [TARGET_URL] [COUNT] [INTERVAL_MS]
#
# Defaults: https://group1.cse356.compas.cs.stonybrook.edu/  3000  200
#
# Tip: run a few sessions back-to-back at different times of day to see
# whether outliers correlate with grader load.

set -euo pipefail

TARGET="${1:-https://group1.cse356.compas.cs.stonybrook.edu/}"
COUNT="${2:-3000}"
INTERVAL_MS="${3:-200}"

OUT_DIR="${OUT_DIR:-./tls-probe-out}"
mkdir -p "$OUT_DIR"
TS="$(date +%Y%m%d-%H%M%S)"
CSV="$OUT_DIR/tls-${TS}.csv"

echo "target:   $TARGET"
echo "count:    $COUNT"
echo "interval: ${INTERVAL_MS} ms"
echo "csv:      $CSV"
echo

echo "i,timestamp,dns_ms,tcp_ms,tls_ms,ttfb_ms,total_ms,http_code,remote_ip" > "$CSV"

sleep_s="$(awk -v m="$INTERVAL_MS" 'BEGIN{printf "%.3f", m/1000}')"
fmt='%{time_namelookup} %{time_connect} %{time_appconnect} %{time_starttransfer} %{time_total} %{http_code} %{remote_ip}\n'

for i in $(seq 1 "$COUNT"); do
  # -k: tolerate cert mismatch if probing by IP
  # --http1.1: pin protocol so timings are comparable across runs
  # -H 'Connection: close': force fresh handshake every iteration
  # --tls-max 1.3: optional, comment out if openssl on probe VM is older
  read -r dns conn appconn starttx total code rip <<<"$(
    curl -sk \
      --http1.1 \
      --connect-timeout 30 \
      --max-time 60 \
      -H 'Connection: close' \
      -o /dev/null \
      -w "$fmt" \
      "$TARGET" \
    || echo "0 0 0 0 0 000 -"
  )"

  ts="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"

  awk -v i="$i" -v ts="$ts" \
      -v dns="$dns" -v conn="$conn" -v app="$appconn" \
      -v stx="$starttx" -v tot="$total" -v code="$code" -v rip="$rip" \
      'BEGIN{
        dns_ms = dns*1000
        tcp_ms = (conn-dns)*1000;     if (tcp_ms < 0) tcp_ms = 0
        tls_ms = (app-conn)*1000;     if (tls_ms < 0) tls_ms = 0
        ttfb_ms = (stx-app)*1000;     if (ttfb_ms < 0) ttfb_ms = 0
        tot_ms = tot*1000
        printf "%d,%s,%.1f,%.1f,%.1f,%.1f,%.1f,%s,%s\n", i, ts, dns_ms, tcp_ms, tls_ms, ttfb_ms, tot_ms, code, rip
      }' >> "$CSV"

  # Live tick — show TLS time so spikes are visible during the run
  tail -1 "$CSV" | awk -F, -v n="$COUNT" \
    '{ printf "\rprobe %4d/%d  tcp=%6.1fms  tls=%6.1fms  total=%6.1fms  ip=%-15s  code=%s     ", $1, n, $4, $5, $7, $9, $8 }'

  sleep "$sleep_s"
done
echo
echo

# ----- summary -----------------------------------------------------------------

awk -F, 'NR>1 {
  n++
  for (c=3; c<=7; c++) {
    v = $c+0
    sum[c] += v
    if (n == 1 || v > mx[c]) mx[c] = v
    arr[c, n] = v
  }
}
END {
  if (!n) { print "no samples"; exit }
  printf "samples: %d\n\n", n
  printf "%-7s %10s %10s %10s %10s %10s\n", "field", "mean", "p50", "p95", "p99", "max"
  split("3 4 5 6 7", idxs, " ")
  split("dns tcp tls ttfb total", names, " ")
  for (k = 1; k <= 5; k++) {
    c = idxs[k]
    # build sorted array
    delete s
    for (i = 1; i <= n; i++) s[i] = arr[c, i]
    # quick insertion sort is fine — n ≤ ~10k
    for (i = 2; i <= n; i++) {
      v = s[i]; j = i - 1
      while (j >= 1 && s[j] > v) { s[j+1] = s[j]; j-- }
      s[j+1] = v
    }
    p50 = s[int(n*0.50)+1]
    p95 = s[int(n*0.95)+1]; if (p95 == "") p95 = s[n]
    p99 = s[int(n*0.99)+1]; if (p99 == "") p99 = s[n]
    printf "%-7s %10.1f %10.1f %10.1f %10.1f %10.1f\n", names[k], sum[c]/n, p50, p95, p99, mx[c]
  }
}' "$CSV"

echo
echo "=== top 25 slowest TLS handshakes ==="
{ head -1 "$CSV"; tail -n +2 "$CSV" | sort -t, -k5 -gr | head -25; } \
  | column -t -s, 2>/dev/null || { head -1 "$CSV"; tail -n +2 "$CSV" | sort -t, -k5 -gr | head -25; }

echo
echo "=== top 25 slowest TCP connects ==="
{ head -1 "$CSV"; tail -n +2 "$CSV" | sort -t, -k4 -gr | head -25; } \
  | column -t -s, 2>/dev/null || { head -1 "$CSV"; tail -n +2 "$CSV" | sort -t, -k4 -gr | head -25; }

echo
echo "=== TLS outlier buckets (ms) ==="
awk -F, 'NR>1 {
  v = $5+0
  if (v < 50)        b["<50"]++
  else if (v < 100)  b["50-100"]++
  else if (v < 250)  b["100-250"]++
  else if (v < 500)  b["250-500"]++
  else if (v < 1000) b["500-1000"]++
  else if (v < 3000) b["1000-3000"]++
  else               b[">=3000"]++
}
END {
  order = "<50 50-100 100-250 250-500 500-1000 1000-3000 >=3000"
  split(order, o, " ")
  for (i = 1; i <= 7; i++) printf "  %-10s %6d\n", o[i], b[o[i]]+0
}' "$CSV"

echo
echo "raw csv: $CSV"
