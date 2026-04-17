require('dotenv').config();

// OTel SDK must be initialized before Sentry — Sentry v8+ uses OTel internally
// and will conflict if it sets up its own SDK first.
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-grpc');

// deployment.environment is set via OTEL_RESOURCE_ATTRIBUTES env var in .env
// so the SDK picks it up automatically without a Resource import.
const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter(),
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-http': {
        // Skip high-volume, low-value incoming requests:
        // - GET / : HAProxy health checks (4 nodes × 2 workers × every 5s)
        // - /uploads/*: static image/asset serving
        ignoreIncomingRequestHook: (req) =>
          req.url === '/' || req.url?.startsWith('/uploads/') || false,
      },
      // Disable instrumentations that generate noisy, low-value spans:
      // fs: spans for every require() and file read
      // dns: DNS lookups (resolved once then OS-cached)
      // net: raw TCP connection spans (redundant with http/pg/redis spans)
      '@opentelemetry/instrumentation-fs': { enabled: false },
      '@opentelemetry/instrumentation-dns': { enabled: false },
      '@opentelemetry/instrumentation-net': { enabled: false },
      '@opentelemetry/instrumentation-redis': { enabled: false },
      '@opentelemetry/instrumentation-ioredis': { enabled: false },
    }),
  ],
});

sdk.start();

// Sentry init after OTel — skipOpenTelemetrySetup tells Sentry to use the
// existing OTel SDK rather than spinning up its own.
const Sentry = require('@sentry/node');

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  sendDefaultPii: true,
  skipOpenTelemetrySetup: true,
});
