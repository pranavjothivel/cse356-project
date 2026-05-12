# Node.js OpenTelemetry Setup

_Last updated: 2026-04-16_

## Collector Endpoint

All app nodes should send traces to the dedicated telemetry node over the **private network**:

```
OTEL_EXPORTER_OTLP_ENDPOINT=http://10.0.0.235:4317
OTEL_EXPORTER_OTLP_PROTOCOL=grpc
```

- `10.0.0.235` — private IP of `group1-telemetry-01` (`130.245.136.96` public)
- Port `4317` — gRPC (preferred over HTTP for efficiency)
- The telemetry node runs Grafana Alloy which receives traces and forwards to Grafana Cloud Tempo

## Grafana Cloud Tempo

Alloy on `group1-telemetry-01` forwards to:

```
tempo-prod-30-prod-us-east-3.grafana.net:443
```

Basic auth username: `1549342` (password stored in `/etc/alloy/config.alloy` on telemetry node).

## Sampling Policy (configured in Alloy)

| Policy | Rule |
|---|---|
| `errors` | Keep 100% of traces with ERROR status |
| `slow-traces` | Keep 100% of traces with duration > 1s |
| `healthy-sample` | Keep 10% of all other traces |

Decision wait: 10s. Max traces in memory: 50,000.

## Firewall

Port `4317` (TCP gRPC) is open on `group1-telemetry-01` inbound from `10.0.0.0/8` (private network only). App nodes connect over private IPs so no public exposure.

## Node.js SDK Setup

Install:

```bash
npm install @opentelemetry/sdk-node \
  @opentelemetry/auto-instrumentations-node \
  @opentelemetry/exporter-trace-otlp-grpc
```

Instrumentation entry point (load before app code, e.g. `src/instrument.js`):

```js
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-grpc');

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter(),
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();
```

The SDK picks up `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_PROTOCOL` automatically from the environment.

## Environment Variables (add to `.env`)

```
OTEL_EXPORTER_OTLP_ENDPOINT=http://10.0.0.235:4317
OTEL_EXPORTER_OTLP_PROTOCOL=grpc
OTEL_SERVICE_NAME=cse356-api
```

Load `src/instrument.js` before the app starts — in `package.json`:

```json
"scripts": {
  "start": "node -r ./src/instrument.js src/app.js"
}
```

Or in PM2 `ecosystem.config.js`:

```js
node_args: '-r ./src/instrument.js'
```
