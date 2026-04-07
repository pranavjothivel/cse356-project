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
app.use('/api/auth', authRouter);
app.use('/api/communities', communitiesRouter);
app.use('/api/channels', channelsRouter);

app.get('/', (req, res) => {
  res.json({ status: 'ok', user: req.user?.username || null });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ──────────────────────────────────────────────
// Start
// ──────────────────────────────────────────────
async function start() {
  await sequelize.authenticate();
  console.log('PostgreSQL connected');

  // Sync tables (use migrations in production)
  await sequelize.sync({ alter: true });

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
