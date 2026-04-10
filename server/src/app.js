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
const { configureWSServer } = require('./ws');

const app = express();

// Trust HAProxy — required for secure cookies and correct req.protocol behind a reverse proxy
app.set('trust proxy', 1);

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

  const port = process.env.PORT || 3000;

  // Run Express and WebSocket server on same port
  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server });
  configureWSServer(wss);
  server.listen(port, () => console.log(`Server running on port ${port}`));
}

start().catch(err => { console.error('Failed to start:', err); process.exit(1); });

module.exports = app;
