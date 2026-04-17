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
        // Skip span creation for static file requests — image/asset serving
        // produces high-volume, low-value traces with no auth context.
        ignoreIncomingRequestHook: (req) =>
          req.url?.startsWith('/uploads/') ?? false,
      },
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
