# Grafana Alloy Setup — Redis Node

## Overview

Grafana Alloy is installed on `group1-db-redis-01` (`130.245.136.86`) to collect OS metrics, system logs, and Redis metrics and ship them to Grafana Cloud.

## What's Collected

| Source | Job Label | Destination |
|---|---|---|
| Alloy self-metrics | `integrations/alloy-check` | Grafana Cloud Prometheus |
| Node (OS) metrics | `integrations/node_exporter` | Grafana Cloud Prometheus |
| Redis metrics | `integrations/redis` | Grafana Cloud Prometheus |
| systemd journal logs | `integrations/node_exporter` | Grafana Cloud Loki |
| `/var/log/*.log` files | `integrations/node_exporter` | Grafana Cloud Loki |

## Installation

Installed via the official Grafana Cloud onboarding script:

```bash
ARCH="amd64" \
GCLOUD_HOSTED_METRICS_URL="https://prometheus-prod-66-prod-us-east-3.grafana.net/api/prom/push" \
GCLOUD_HOSTED_METRICS_ID="<metrics-id>" \
GCLOUD_SCRAPE_INTERVAL="60s" \
GCLOUD_HOSTED_LOGS_URL="https://logs-prod-042.grafana.net/loki/api/v1/push" \
GCLOUD_HOSTED_LOGS_ID="<logs-id>" \
GCLOUD_RW_API_KEY="<api-key>" \
/bin/sh -c "$(curl -fsSL https://storage.googleapis.com/cloud-onboarding/alloy/scripts/install-linux.sh)"
```

Config is written to `/etc/alloy/config.alloy` and managed by `alloy.service` (systemd).

## Redis Exporter User

A non-privileged `alloy` Redis user is created with the minimum commands needed for metrics collection:

```
redis-cli ACL SETUSER alloy on '>REDACTED' \
  '+client' '+info' '+config|get' '+cluster|info' \
  '+slowlog' '+latency' '+memory' '+xlen' \
  '+subscribe' '+unsubscribe' '+psubscribe' '+punsubscribe' \
  '+publish' '+ping' '+dbsize' '+scan' '~*'
redis-cli CONFIG REWRITE
```

The password is stored only in `/etc/alloy/config.alloy` on the node.

## Config Structure (`/etc/alloy/config.alloy`)

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
  rule { target_label = "instance" replacement = "default" }
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
    instance    = "default",
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

prometheus.exporter.redis "integrations_redis" {
  redis_addr     = "localhost:6379"
  redis_user     = "alloy"
  redis_password = "<redis-alloy-password>"
}

discovery.relabel "integrations_redis" {
  targets = prometheus.exporter.redis.integrations_redis.targets
  rule { target_label = "instance" replacement = constants.hostname }
  rule { target_label = "job"      replacement = "integrations/redis" }
}

prometheus.scrape "integrations_redis" {
  targets         = discovery.relabel.integrations_redis.output
  forward_to      = [prometheus.remote_write.metrics_service.receiver]
  scrape_interval = "60s"
}
```

## Managing the Service

```bash
systemctl status alloy.service
systemctl restart alloy.service
journalctl -u alloy.service -f
```

## Verifying Data is Flowing

Check internal Alloy metrics (from the node):

```bash
curl -s http://127.0.0.1:12345/metrics | grep prometheus_remote_storage_samples_total
```

A non-zero and increasing value confirms samples are being sent to Grafana Cloud.
