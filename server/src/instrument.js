// Instrumentation disabled — see PR #120 for context.
// Re-enable OTel/Sentry here when ready.

// require('dotenv').config();
//
// const { NodeSDK } = require('@opentelemetry/sdk-node');
// const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
// const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-grpc');
//
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
//     }),
//   ],
// });
//
// sdk.start();
//
// const Sentry = require('@sentry/node');
//
// Sentry.init({
//   dsn: process.env.SENTRY_DSN,
//   sendDefaultPii: true,
//   skipOpenTelemetrySetup: true,
// });
