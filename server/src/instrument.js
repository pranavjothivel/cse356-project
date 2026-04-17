require('dotenv').config();

// OTel SDK must be initialized before Sentry — Sentry v8+ uses OTel internally
// and will conflict if it sets up its own SDK first.
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-grpc');

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter(),
  instrumentations: [getNodeAutoInstrumentations()],
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
