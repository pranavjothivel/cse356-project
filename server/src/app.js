require('./instrument');
require('dotenv').config();
const express = require('express');
const session = require('express-session');
//const pgSession = require('connect-pg-simple')(session);
const { RedisStore } = require('connect-redis');
const { Pool } = require('pg');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');

const sequelize = require('./db');
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
const redisClient = require('./redis');
const { configureWSServer, initWS } = require('./ws');

const app = express();

// Trust HAProxy — required for secure cookies and correct req.protocol behind a reverse proxy
app.set('trust proxy', 1);


/**
 * route -> { reqs (number of requests), sumResponse (sum of response times) }
 */
let metrics = new Map();

app.use((req, res, next) => {
  // Make sure to replace uuid route params with :id
  let route = req.method + " " + req.path.replaceAll(/[0-9|a-f]*-[0-9|a-f]*-[0-9|a-f]*-[0-9|a-f]*-[0-9|a-f]*/g, ':id');

  let date1 = Date.now();
  res.on('finish', () => {
    try {
      let date2 = Date.now();
      let metric = metrics.get(route);
      if (!metric) {
        metric = {reqs: 0, sumResponse: 0}
      }
      metric.reqs++;
      metric.sumResponse += date2 - date1;
      metrics.set(route, metric);
    }
    catch (err) {}
  });
  next();
});

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
      html += `<p>${v[0]}: Requests: ${v[1].reqs}, Average: ${(v[1].sumResponse / v[1].reqs).toFixed(3)}</p>`;
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
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 14 * 24 * 60 * 60 * 1000, // 14 days
  },
}));

app.use(passport.initialize());
app.use(passport.session());

// ──────────────────────────────────────────────
// Routes
// ──────────────────────────────────────────────
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

// TEMP: Sentry test trigger — remove after verifying event in dashboard
app.get('/api/debug-sentry', (req, res) => { throw new Error('Sentry test error'); });

const Sentry = require('@sentry/node');
Sentry.setupExpressErrorHandler(app);

app.use((err, req, res, next) => {
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
  console.log('PostgreSQL connected');

  // In dev, alter:true auto-applies model changes for convenience.
  // In production, alter:true re-creates unique indexes on every boot
  // (Sequelize bug), which bloats the schema. Schema changes in production
  // go through server/scripts/migrations instead.
  await sequelize.sync({ alter: process.env.NODE_ENV !== 'production' });

  await setupOidcStrategy();

  // Connect + subscribe the Redis pub/sub subscriber before accepting any
  // requests. If this fails the worker crashes and PM2 restarts it — much
  // better than silently running with a dead subscriber that drops
  // presence.changed fanout from the other node.
  await initWS();

  const port = process.env.PORT || 3000;

  // Run Express and WebSocket server on same port
  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server });
  configureWSServer(wss);
  server.listen(port, () => console.log(`Server running on port ${port}`));
}

start().catch(err => { console.error('Failed to start:', err); process.exit(1); });

module.exports = app;
