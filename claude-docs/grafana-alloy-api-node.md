# Grafana Alloy Setup — API Node

_Last updated: 2026-04-29_

## Overview

Grafana Alloy is installed on each API app node (`group1-api-node-01`..`05`) to collect OS metrics, system logs, and Alloy self-metrics, shipping them to Grafana Cloud. API nodes are **OTel trace clients only** — they send Node.js traces over the private network to the dedicated telemetry node (`group1-telemetry-01`, `10.0.0.235:4317`), which is the only host running an OTel collector. See [`grafana-alloy-telemetry-node.md`](grafana-alloy-telemetry-node.md) for the receiver/Tempo pipeline and [`otel-nodejs-setup.md`](otel-nodejs-setup.md) for the Node SDK config.

## What's Collected

| Source | Job Label | Destination |
|---|---|---|
| Alloy self-metrics | `integrations/alloy-check` | Grafana Cloud Prometheus |
| Node (OS) metrics | `integrations/node_exporter` | Grafana Cloud Prometheus |
| systemd journal | `integrations/node_exporter` | Grafana Cloud Loki |
| `/var/log/{syslog,messages,*.log}` | `integrations/node_exporter` | Grafana Cloud Loki |

**Not collected at this layer:** Node.js application traces (handled by the OTel SDK, sent directly to the telemetry node — bypasses Alloy on this host). PM2 / app process metrics (not yet wired up).

## Installation

Installed via the Grafana apt repo directly (the Grafana Cloud onboarding script is unnecessary since we mirror an existing node's config):

```bash
mkdir -p /etc/apt/keyrings
wget -qO - https://apt.grafana.com/gpg.key | gpg --dearmor -o /etc/apt/keyrings/grafana.gpg
echo "deb [signed-by=/etc/apt/keyrings/grafana.gpg] https://apt.grafana.com stable main" \
  > /etc/apt/sources.list.d/grafana.list
apt-get update -qq
apt-get install -y -qq alloy
systemctl enable alloy
```

Config lives at `/etc/alloy/config.alloy` (mode 640, owned by `root:alloy`) and is managed by `alloy.service` (systemd).

## Hostname Labeling

Every `instance` label uses `constants.hostname` — the Alloy built-in resolved at runtime from the host's hostname. Each node ships under its own label, so adding a new node never collides with an existing one:

| Block | Label set |
|---|---|
| `discovery.relabel "alloy_check"` | `instance = constants.hostname` |
| `discovery.relabel "alloy_check"` | `alloy_hostname = constants.hostname` |
| `discovery.relabel "integrations_node_exporter"` | `instance = constants.hostname` |
| `local.file_match` log targets | `instance = constants.hostname` |

This is a deliberate divergence from the Redis-node config (which hardcodes `instance = "default"`).

## Config (`/etc/alloy/config.alloy`)

Secrets (`<metrics-id>`, `<logs-id>`, `<api-key>`) are redacted — pull live values from any existing API node:

```bash
ssh root@<existing-api-node> 'cat /etc/alloy/config.alloy'
```

```alloy
prometheus.exporter.self "alloy_check" { }

discovery.relabel "alloy_check" {
  targets = prometheus.exporter.self.alloy_check.targets
  rule { target_label = "instance"       replacement = constants.hostname }
  rule { target_label = "alloy_hostname" replacement = constants.hostname }
  rule { target_label = "job"            replacement = "integrations/alloy-check" }
}

prometheus.scrape "alloy_check" {
  targets         = discovery.relabel.alloy_check.output
  forward_to      = [prometheus.relabel.alloy_check.receiver]
  scrape_interval = "60s"
}

prometheus.relabel "alloy_check" {
  forward_to = [prometheus.remote_write.metrics_service.receiver]
  rule {
    source_labels = ["__name__"]
    regex         = "(prometheus_target_sync_length_seconds_sum|prometheus_target_scrapes_.*|prometheus_target_interval.*|prometheus_sd_discovered_targets|alloy_build.*|prometheus_remote_write_wal_samples_appended_total|process_start_time_seconds)"
    action        = "keep"
  }
}

prometheus.remote_write "metrics_service" {
  endpoint {
    url = "https://prometheus-prod-66-prod-us-east-3.grafana.net/api/prom/push"
    basic_auth {
      username = "<metrics-id>"
      password = "<api-key>"
    }
  }
}

loki.write "grafana_cloud_loki" {
  endpoint {
    url = "https://logs-prod-042.grafana.net/loki/api/v1/push"
    basic_auth {
      username = "<logs-id>"
      password = "<api-key>"
    }
  }
}

prometheus.exporter.unix "integrations_node_exporter" {
  disable_collectors = ["ipvs", "btrfs", "infiniband", "xfs", "zfs"]
  filesystem {
    fs_types_exclude     = "^(autofs|binfmt_misc|bpf|cgroup2?|configfs|debugfs|devpts|devtmpfs|tmpfs|fusectl|hugetlbfs|iso9660|mqueue|nsfs|overlay|proc|procfs|pstore|rpc_pipefs|securityfs|selinuxfs|squashfs|sysfs|tracefs)$"
    mount_points_exclude = "^/(dev|proc|run/credentials/.+|sys|var/lib/docker/.+)($|/)"
    mount_timeout        = "5s"
  }
  netclass { ignored_devices = "^(veth.*|cali.*|[a-f0-9]{15})$" }
  netdev   { device_exclude  = "^(veth.*|cali.*|[a-f0-9]{15})$" }
}

discovery.relabel "integrations_node_exporter" {
  targets = prometheus.exporter.unix.integrations_node_exporter.targets
  rule { target_label = "instance" replacement = constants.hostname }
  rule { target_label = "job"      replacement = "integrations/node_exporter" }
}

prometheus.scrape "integrations_node_exporter" {
  targets    = discovery.relabel.integrations_node_exporter.output
  forward_to = [prometheus.relabel.integrations_node_exporter.receiver]
}

prometheus.relabel "integrations_node_exporter" {
  forward_to = [prometheus.remote_write.metrics_service.receiver]
  rule {
    source_labels = ["__name__"]
    regex         = "node_scrape_collector_.+"
    action        = "drop"
  }
}

loki.source.journal "logs_integrations_integrations_node_exporter_journal_scrape" {
  max_age       = "24h0m0s"
  relabel_rules = discovery.relabel.logs_integrations_integrations_node_exporter_journal_scrape.rules
  forward_to    = [loki.write.grafana_cloud_loki.receiver]
}

local.file_match "logs_integrations_integrations_node_exporter_direct_scrape" {
  path_targets = [{
    __address__ = "localhost",
    __path__    = "/var/log/{syslog,messages,*.log}",
    instance    = constants.hostname,
    job         = "integrations/node_exporter",
  }]
}

discovery.relabel "logs_integrations_integrations_node_exporter_journal_scrape" {
  targets = []
  rule { source_labels = ["__journal__systemd_unit"]    target_label = "unit" }
  rule { source_labels = ["__journal__boot_id"]         target_label = "boot_id" }
  rule { source_labels = ["__journal__transport"]       target_label = "transport" }
  rule { source_labels = ["__journal_priority_keyword"] target_label = "level" }
}

loki.source.file "logs_integrations_integrations_node_exporter_direct_scrape" {
  targets    = local.file_match.logs_integrations_integrations_node_exporter_direct_scrape.targets
  forward_to = [loki.write.grafana_cloud_loki.receiver]
}
```

## Managing the Service

```bash
systemctl status alloy.service
systemctl restart alloy.service
journalctl -u alloy.service -f
```

## Verifying Data is Flowing

From the node:

```bash
curl -s http://127.0.0.1:12345/metrics | grep prometheus_remote_storage_samples_total
```

A non-zero, increasing counter confirms samples are being shipped to Grafana Cloud.

In Grafana Cloud:
- Prometheus: `up{instance="<hostname>"}` = 1
- Loki: filter `host=<hostname>` → journal lines visible
