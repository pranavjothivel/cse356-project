// require('./instrument');
require('dotenv').config();
// const { trace, SpanStatusCode } = require('@opentelemetry/api');
// const os = require('os');
// const HOSTNAME = os.hostname();
const express = require('express');
const session = require('express-session');
//const pgSession = require('connect-pg-simple')(session);
const { RedisStore } = require('connect-redis');
const { Pool } = require('pg');
const cors = require('cors');
const http = require('http');

// OTel, Sentry, Express internals, and our metrics middleware each attach a
// 'finish' listener per response — bump the prototype limit to silence the
// MaxListenersExceededWarning (not a memory leak, just multiple legitimate listeners).
// http.ServerResponse.prototype.setMaxListeners(25);
const WebSocket = require('ws');

const { sequelize, searchSequelize } = require('./db');
require('./models'); // register all models + associations
const { passport, setupOidcStrategy } = require('./auth/passport');
const authRouter = require('./routes/auth');
const communitiesRouter = require('./routes/communities');
const channelsRouter = require('./routes/channels');
const conversationsRouter = require('./routes/conversations');
const usersRouter = require('./routes/users');
const uploadRouter = require('./routes/upload');
const searchRouter = require('./routes/search');
const messagesRouter = require('./routes/messages');
const { redisClient } = require('./redis');
const { configureWSServer, initWSPublisher, initWSSubscriber } = require('./ws');

const app = express();

// Trust HAProxy — required for secure cookies and correct req.protocol behind a reverse proxy
app.set('trust proxy', 1);

// WORKER_ROLE: 'all' (default — serves both API and WS), 'http' (skip WS server),
// or 'ws' (skip API route mounts). Set per-node via .env injected by the
// rolling-hot-deploy workflow based on the `ws_only` flag in infra/nodes.yml.
// Pinning WS to a dedicated node isolates the WS event loop from API request
// bursts (large search responses, long-running queries) and lets us tune
// resources independently for each workload.
const WORKER_ROLE = process.env.WORKER_ROLE || 'all';
console.log(`WORKER_ROLE=${WORKER_ROLE}`);

// Event-loop-lag telemetry. Off by default; flip on with LOG_EL_LAG=1 in the
// worker env to emit a JSON line every 5 s with p50/p99/max event-loop delay.
// Used to attribute Delivery-p95 spikes: lag stays low during a spike → root
// cause is outside the worker (Redis stall, network, LB). lag jumps to seconds
// → root cause is inside the worker (GC, sync work, hot loop).
{
  const { monitorEventLoopDelay } = require('perf_hooks');
  const elLag = monitorEventLoopDelay({ resolution: 10 });
  elLag.enable();
  setInterval(() => {
    if (process.env.LOG_EL_LAG === '1') {
      console.log(JSON.stringify({
        evt: 'el_lag',
        role: WORKER_ROLE,
        pid: process.pid,
        p50_ms: Math.round(elLag.percentile(50) / 1e6),
        p99_ms: Math.round(elLag.percentile(99) / 1e6),
        max_ms: Math.round(elLag.max / 1e6),
      }));
    }
    elLag.reset();
  }, 5000).unref();
}


/**
 * route -> { reqs (number of requests), sumResponse (sum of response times), 
 * last500BatchSum, current500BatchSum, current500Batch (these average response times in batches of 500)}
 */
let metrics = new Map();

// Metrics middleware temporarily disabled to A/B-test its hot-path cost.
// `metrics` Map and the GET /api/metrics endpoint remain; the endpoint will
// just return an empty list while this is off. Re-enable by uncommenting if
// the disable doesn't move P95 in the expected direction.
// app.use((req, res, next) => {
//   // Make sure to replace uuid route params with :id
//   let route = req.method + " " + req.path.replaceAll(/[0-9|a-f]*-[0-9|a-f]*-[0-9|a-f]*-[0-9|a-f]*-[0-9|a-f]*/g, ':id');
//
//   let date1 = Date.now();
//   res.on('finish', () => {
//     try {
//       let date2 = Date.now();
//       let metric = metrics.get(route);
//       if (!metric) {
//         metric = {reqs: 0, sumResponse: 0, last500Sum: 0, current500Sum: 0, current500: 0}
//       }
//       let resTime = date2 - date1;
//       metric.reqs++;
//       metric.sumResponse += resTime;
//       metric.current500Sum += resTime;
//       metric.current500++;
//       if (metric.current500 === 500) {
//         metric.current500 = 0;
//         metric.last500Sum = metric.current500Sum;
//         metric.current500Sum = 0;
//       }
//       metrics.set(route, metric);
//     }
//     catch (err) {}
//   });
//   next();
// });

// GET /api/metrics?sort=[name or reqs or avg]
app.get('/api/metrics', (req, res, next) => {
  try {
    let { sort } = req.query;
    if (!sort) sort = "name";

    let metricsArray = [...metrics];
    if (sort === "name") metricsArray.sort();
    else if (sort === "reqs") metricsArray.sort((a, b) => b[1].reqs - a[1].reqs);
    else if (sort === "avg") metricsArray.sort((a, b) => b[1].sumResponse / b[1].reqs - a[1].sumResponse / a[1].reqs);

    let html = '';
    metricsArray.forEach((v) => {
      html += `<p>${v[0]}: Requests: ${v[1].reqs}, Average: ${(v[1].sumResponse / v[1].reqs).toFixed(3)}, Last 500 Average: ${(v[1].last500Sum / 500).toFixed(3)}</p>`;
    });
    return res.send(html);
  }
  catch (err) {
    console.log(err);
    return res.sendStatus(500);
  }
});


// ──────────────────────────────────────────────
// Middleware
// ──────────────────────────────────────────────

app.use(cors({
  origin: [
    process.env.FRONTEND_URL
  ],
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Sessions stored in Postgres — each session is independent.
// Signing out destroys only the one session row; other sessions are unaffected.
app.use(session({
  store: new RedisStore({ client: redisClient }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    // Hardcoded Secure in production. If/when any frontend serves plain
    // HTTP (e.g. lb02 :80 currently does), this MUST be relaxed to 'auto'
    // — otherwise the Set-Cookie header is silently dropped on HTTP
    // requests and login through that frontend presents as "200 then 401".
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 14 * 24 * 60 * 60 * 1000, // 14 days
  },
}));

app.use(passport.initialize());
app.use(passport.session());

// Attach request-level span attributes not covered by auto-instrumentation:
// - client.address:           real client IP (OTel semconv; respects HAProxy X-Forwarded-For)
// - host.name:                hostname of this app node (identifies which node served the request)
// - http.x_request_id:        per-request UUID generated by HAProxy (X-Request-ID)
// - enduser.is_authenticated:  boolean auth state, set on every request
// - enduser.id:               authenticated user UUID (omitted when unauthenticated)
// - enduser.username:         authenticated username (omitted when unauthenticated)
// OTel span attributes disabled — see PR #128
// app.use((req, res, next) => {
//   const span = trace.getActiveSpan();
//   if (span) {
//     if (req.ip) span.setAttribute('client.address', req.ip);
//     span.setAttribute('host.name', HOSTNAME);
//     const requestId = req.headers['x-request-id'];
//     if (requestId) span.setAttribute('http.x_request_id', requestId);
//     span.setAttribute('enduser.is_authenticated', !!req.user);
//     if (req.user) {
//       const userId = req.user.id ?? req.user.username;
//       if (userId != null) span.setAttribute('enduser.id', String(userId));
//       if (req.user.username) span.setAttribute('enduser.username', req.user.username);
//     }
//   }
//   next();
// });

// ──────────────────────────────────────────────
// Routes
// ──────────────────────────────────────────────
// HAProxy health check (`option httpchk GET /`) needs a 200 from every node
// regardless of role — defined unconditionally below so WS-only nodes still
// pass the check.

if (WORKER_ROLE !== 'ws') {
  app.use('/uploads', express.static(process.env.UPLOAD_DIR || 'uploads'));
  app.use('/api/upload', uploadRouter);
  app.use('/api/search', searchRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/communities', communitiesRouter);
  app.use('/api/channels', channelsRouter);
  app.use('/api/conversations', conversationsRouter);
  app.use('/api/messages', messagesRouter);
  app.use('/api/users', usersRouter);

  app.get('/', (req, res) => {
    res.json({ status: 'ok', user: req.user?.username || null });
  });
} else {
  // WS-only: HAProxy shouldn't route /api/* here, but during the deploy
  // window between node reload and HAProxy reload, it may. Return 503 with
  // Retry-After so HAProxy `option redispatch` + `retry-on` can route the
  // request to a different backend instead of surfacing a 404 to the client.
  app.get('/', (req, res) => res.json({ status: 'ok', role: 'ws' }));
  app.use('/api', (req, res) => {
    res.set('Retry-After', '1').status(503).json({ error: 'WS-only node — retry on another backend' });
  });
}

// const Sentry = require('@sentry/node');
// Sentry.setupExpressErrorHandler(app);

app.use((err, req, res, next) => {
  // const span = trace.getActiveSpan();
  // if (span) {
  //   span.recordException(err);
  //   span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
  // }
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ──────────────────────────────────────────────
// Process-level error handlers
// ──────────────────────────────────────────────
// Last-resort safety net: any uncaught exception or unhandled rejection in a
// background handler (WS connection, Redis subscriber, timer callback, etc.)
// is logged and swallowed so PM2 does not crash-loop the worker. Route-level
// errors should still be caught by try/catch and the Express error middleware
// above; this is only for errors that escape those boundaries.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

// ──────────────────────────────────────────────
// Start
// ──────────────────────────────────────────────
async function start() {
  await sequelize.authenticate();
  await searchSequelize.authenticate();
  console.log('PostgreSQL connected');

  // In dev, alter:true auto-applies model changes for convenience.
  // In production, alter:true re-creates unique indexes on every boot
  // (Sequelize bug), which bloats the schema. Schema changes in production
  // go through server/scripts/migrations instead.
  await sequelize.sync({ alter: process.env.NODE_ENV !== 'production' });

  // Fire-and-forget: a thrown error in setupOidcStrategy (e.g. Keycloak
  // unreachable at boot) would otherwise propagate up and crash the PM2
  // worker before it can listen, putting the whole node into a restart
  // loop. OIDC is a degraded-but-optional login path; the rest of the app
  // should come up.
  setupOidcStrategy().catch(err => console.error('OIDC setup failed (non-fatal):', err.message));

  // Publisher is needed by REST handlers (broadcastToUsers in messages.js
  // etc.) on EVERY node — including api_only nodes that don't accept WS
  // connections themselves. Calling publishClient.publish() on a never-
  // connected client silently drops the broadcast.
  await initWSPublisher();

  // Subscriber is only useful on workers that have local WS connections to
  // deliver inbound broadcasts to. Skipping on api_only nodes saves the
  // cost of receiving every cluster broadcast (~10MB/sec at our scale)
  // just to iterate an empty local users Map and discard.
  if (WORKER_ROLE !== 'http') {
    await initWSSubscriber();
  }

  const port = process.env.PORT || 3000;

  // Run Express on the HTTP server unconditionally (needed for HAProxy
  // health checks regardless of role). Attach the WebSocket server only
  // when this worker handles WS traffic.
  const server = http.createServer(app);
  if (WORKER_ROLE !== 'http') {
    const wss = new WebSocket.Server({ server });
    configureWSServer(wss);
  }
  server.listen(port, () => console.log(`Server running on port ${port} (role=${WORKER_ROLE})`));
}

start().catch(err => { console.error('Failed to start:', err); process.exit(1); });

module.exports = app;
