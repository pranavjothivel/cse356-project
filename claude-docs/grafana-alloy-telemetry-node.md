# Grafana Alloy Setup — Telemetry Node (OTel Collector)

_Last updated: 2026-04-16_

## Node

`group1-telemetry-01` — `130.245.136.96` (public) / `10.0.0.235` (private)

## What's Collected

| Source | Job / Destination |
|---|---|
| Alloy self-metrics | `integrations/alloy-check` → Grafana Cloud Prometheus |
| OS (node_exporter) metrics | `integrations/node_exporter` → Grafana Cloud Prometheus |
| systemd journal + `/var/log/*.log` | → Grafana Cloud Loki |
| OTel traces (gRPC, port 4317) | → Grafana Cloud Tempo |

## OTel Trace Pipeline

Appended to `/etc/alloy/config.alloy`:

```alloy
otelcol.receiver.otlp "default" {
  grpc {
    endpoint = "0.0.0.0:4317"
  }
  output {
    traces = [otelcol.processor.batch.default.input]
  }
}

otelcol.processor.batch "default" {
  output {
    traces = [otelcol.processor.tail_sampling.default.input]
  }
}

otelcol.processor.tail_sampling "default" {
  policy {
    name = "errors"
    type = "status_code"
    status_code {
      status_codes = ["ERROR"]
    }
  }

  policy {
    name = "slow-traces"
    type = "latency"
    latency {
      threshold_ms = 1000
    }
  }

  policy {
    name = "healthy-sample"
    type = "probabilistic"
    probabilistic {
      sampling_percentage = 10
    }
  }

  decision_wait               = "10s"
  num_traces                  = 50000
  expected_new_traces_per_sec = 100

  output {
    traces = [otelcol.exporter.otlp.tempo.input]
  }
}

otelcol.exporter.otlp "tempo" {
  client {
    endpoint = "tempo-prod-30-prod-us-east-3.grafana.net:443"
    auth     = otelcol.auth.basic.tempo.handler
    tls {
      insecure = false
    }
  }
}

otelcol.auth.basic "tempo" {
  username = "1549342"
  password = "<tempo-token>"
}
```

### Sampling Policy

| Policy | Rule |
|---|---|
| `errors` | Keep all traces with `ERROR` status |
| `slow-traces` | Keep all traces with duration > 1s |
| `healthy-sample` | Keep 10% of remaining traces |

## App Node Environment Variables

Set these on all API nodes (in `.env` or PM2 env) so the Node.js OTel SDK sends traces to the collector over the private network:

```
OTEL_EXPORTER_OTLP_ENDPOINT=http://10.0.0.235:4317
OTEL_EXPORTER_OTLP_PROTOCOL=grpc
```

Use the private IP (`10.0.0.235`) to keep trace traffic off the public interface.

## Managing the Service

```bash
systemctl status alloy.service
systemctl restart alloy.service
journalctl -u alloy.service -f
```
