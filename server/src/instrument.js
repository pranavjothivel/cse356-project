require('dotenv').config();

// OTel SDK must be initialized before Sentry — Sentry v8+ uses OTel internally
// and will conflict if it sets up its own SDK first.
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-grpc');

// deployment.environment is set via OTEL_RESOURCE_ATTRIBUTES env var in .env
// so the SDK picks it up automatically without a Resource import.
// OTel auto-instrumentation fully disabled while investigating delivery
// latency. Re-enable selectively once baseline is established.
// See PR #120 for context.

// const sdk = new NodeSDK({
//   traceExporter: new OTLPTraceExporter(),
//   instrumentations: [
//     getNodeAutoInstrumentations({
//       '@opentelemetry/instrumentation-http': {
//         ignoreIncomingRequestHook: (req) =>
//           req.url === '/' || req.url?.startsWith('/uploads/') || false,
//       },
//       '@opentelemetry/instrumentation-fs': { enabled: false },
//       '@opentelemetry/instrumentation-dns': { enabled: false },
//       '@opentelemetry/instrumentation-net': { enabled: false },
//       '@opentelemetry/instrumentation-redis': { enabled: false },
//       '@opentelemetry/instrumentation-ioredis': { enabled: false },
//       '@opentelemetry/instrumentation-pg': { enabled: false },
//       '@opentelemetry/instrumentation-generic-pool': { enabled: false },
//     }),
//   ],
// });
//
// sdk.start();

// Sentry init after OTel — skipOpenTelemetrySetup tells Sentry to use the
// existing OTel SDK rather than spinning up its own.
const Sentry = require('@sentry/node');

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  sendDefaultPii: true,
  skipOpenTelemetrySetup: true,
});
