# tls-probe.sh

External TLS handshake latency probe for the HAProxy LB.

## Why this exists

Our cluster-internal delivery p95 (HTTP handle + broadcast + Redis pub/sub +
WS send) is ~127ms / p99 ~190ms across ~31k samples, but the grader's
Delivery p95 oscillates 1000-3000ms during peak load and drops below 800ms
at night. There is a ~900-2900ms gap between what we see inside the cluster
and what the load generators see.

Hypothesis: the gap lives in the TCP/TLS path between external clients
and HAProxy on `130.245.136.254` — handshake stalls, SYN drops, retransmits,
or upstream network behavior that varies with grader load.

Per Prof. Ferdman: "look for massive outliers rather than do any kind of
careful P95 tracking." The grader doesn't actually need to be sending real
requests; a `GET /` is enough — we're troubleshooting the connection, not
the app.

## What the script does

For each iteration:

1. Opens a fresh TCP connection to the LB (`Connection: close`, no reuse).
2. Completes a full TLS 1.x handshake.
3. Sends `GET /` over HTTP/1.1.
4. Records curl's per-phase timings: `time_namelookup`, `time_connect`,
   `time_appconnect`, `time_starttransfer`, `time_total`.

Per-iteration timings are written to a CSV under `./tls-probe-out/` and a
live status line is printed during the run. At the end it prints:

- Percentile table (mean / p50 / p95 / p99 / max) for dns, tcp, tls, ttfb, total
- Top-25 slowest TLS handshakes
- Top-25 slowest TCP connects
- Outlier bucket histogram for TLS (`<50`, `50-100`, `100-250`, `250-500`,
  `500-1000`, `1000-3000`, `>=3000` ms)

## Where to run it

**On an external VM, not inside our cluster.** The whole point is to
reproduce the load generator's vantage point. A small Linode / EC2 / DO
droplet with stable network is fine. Your laptop works in a pinch but adds
your home network as a confounder.

Requirements: bash, curl (any reasonably recent version), awk.

## Usage

```bash
./tls-probe.sh [TARGET_URL] [COUNT] [INTERVAL_MS]
```

Defaults:

```
TARGET_URL    https://group1.cse356.compas.cs.stonybrook.edu/
COUNT         3000
INTERVAL_MS   200
```

Examples:

```bash
# default 3000-probe run during peak grader load
./tls-probe.sh

# longer run, faster cadence
./tls-probe.sh https://group1.cse356.compas.cs.stonybrook.edu/ 10000 100

# probe by IP, skip DNS, accept self-signed
./tls-probe.sh https://130.245.136.254/ 3000 200
```

Output CSV: `./tls-probe-out/tls-YYYYMMDD-HHMMSS.csv` with columns
`i,timestamp,dns_ms,tcp_ms,tls_ms,ttfb_ms,total_ms,http_code,remote_ip`.

## Suggested experiment

Run two back-to-back sessions: one during peak grader load (when our p95
is 1000-3000ms) and one late night (when it drops to sub-800ms). Compare
the TLS outlier bucket histograms.

Interpretation:

- **Clean tail at both times** (no >500ms TLS handshakes): the LB-side TLS
  path is exonerated; the gap is somewhere else (grader-side network, our
  WS write path under contention, etc.).
- **Same multi-second tail at peak** that disappears at night: the gap is
  in the TCP/TLS layer between external clients and HAProxy. Next steps:
  check HAProxy's `ssl_fc_handshake_time`, conntrack table, SYN backlog,
  CPU on the LB during peak.
- **TCP slow but TLS fast**: SYN drops or retransmits — look at the LB's
  network stack and upstream link.
- **TCP fast but TLS slow**: HAProxy worker starvation during the
  handshake — check LB CPU and `ssl-default-bind-options`.

## Design notes

- `--http1.1` and `Connection: close` force a fresh handshake every
  iteration. Keep-alive reuse would hide exactly the tail we're hunting.
- 200ms default spacing keeps the probe from self-inducing load. We want
  to detect outliers caused by *other* traffic, not by our own.
- `remote_ip` is logged so if the hostname ever resolves to a different
  address (DNS round-robin, failover) it shows up in the data.
- `-k` is set so the script works whether you target by hostname or by IP.
