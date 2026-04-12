const express = require('express');
const router = express.Router();
const passport = require('passport');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');

const User = require('../models/User');
const { minioClient, BUCKET } = require('../upload');
const { broadcastToAllConnected, withUserPresenceLock, notifyUserAwayFrame } = require('../ws');
const redisClient = require('../redis');

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

/**
 * Map a Sequelize error to an HTTP response if it represents a unique-constraint
 * violation on the users table. Returns true if the response was sent.
 */
function handleUniqueUserConflict(err, res) {
  if (err && err.name === 'SequelizeUniqueConstraintError') {
    // err.errors is an array of ValidationErrorItem; path is the column name.
    const path = err.errors && err.errors[0] && err.errors[0].path;
    let field = 'username';
    if (typeof path === 'string') {
      if (path.includes('email')) field = 'email';
      else if (path.includes('username')) field = 'username';
    }
    res.status(409).json({ error: `${field === 'email' ? 'Email' : 'Username'} already taken`, field });
    return true;
  }
  return false;
}

function oauthSuccessHandler(provider) {
  return (req, res, next) => {
    passport.authenticate(provider, { session: false, passReqToCallback: true }, async (err, user, info) => {
      if (err) return next(err);

      if (req.isAuthenticated() && user) {
        return res.redirect('/auth/settings?linked=' + provider);
      }

      if (user) {
        return req.logIn(user, (loginErr) => {
          if (loginErr) return next(loginErr);
          //res.redirect('/');
          res.redirect(process.env.FRONTEND_URL.replace(/\/$/, '') + "/");
        });
      }

      if (info?.message === 'pending_link' && req.session.pendingOAuth) {
        return req.session.save(() => {
          res.redirect(process.env.FRONTEND_URL.replace(/\/$/, '') + "/login?oauth=true");
        });
      }

      res.redirect('/auth/login?error=oauth_failed');
    })(req, res, next);
  };
}

// ──────────────────────────────────────────────
// Local auth
// ──────────────────────────────────────────────

// POST /auth/register
router.post('/register', async (req, res, next) => {
  try {
    const { username, password, email } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const user = User.build({ username, email: email || null, display_name: username });
    await user.setPassword(password);

    try {
      await user.save();
    } catch (err) {
      if (handleUniqueUserConflict(err, res)) return;
      throw err;
    }

    req.logIn(user, (err) => {
      if (err) return next(err);
      res.status(201).json({ message: 'Account created', userId: user.id });
    });
  } catch (err) {
    next(err);
  }
});

// POST /auth/login
router.post('/login', (req, res, next) => {
  passport.authenticate('local', (err, user, info) => {
    if (err) return next(err);
    if (!user) return res.status(401).json({ error: info?.message || 'Invalid credentials' });
    req.logIn(user, (loginErr) => {
      if (loginErr) return next(loginErr);
      res.json({ message: 'Logged in', userId: user.id });
    });
  })(req, res, next);
});

// POST /auth/logout — only destroys the current session
router.post('/logout', (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie('connect.sid');
    res.json({ message: 'Logged out' });
  });
});

// GET /auth/me
router.get('/me', requireAuth, (req, res) => {
  const { id, username, email, display_name, providers, away, away_msg, avatar } = req.user;
  res.json({
    id,
    username,
    email,
    displayName: display_name,
    providers: (providers || []).map(p => ({ provider: p.provider, displayName: p.display_name })),
    hasPassword: !!req.user.password_hash,
    away,
    away_msg,
    avatar
  });
});

// ──────────────────────────────────────────────
// Google
// ──────────────────────────────────────────────
router.get('/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
router.get('/google/callback', oauthSuccessHandler('google'));

// ──────────────────────────────────────────────
// GitHub
// ──────────────────────────────────────────────
router.get('/github', passport.authenticate('github', { scope: ['user:email'] }));
router.get('/github/callback', oauthSuccessHandler('github'));

// ──────────────────────────────────────────────
// Course OIDC
// ──────────────────────────────────────────────
router.get('/oidc', passport.authenticate('oidc', { scope: 'openid email profile' }));
router.get('/oidc/callback', oauthSuccessHandler('oidc'));

// ──────────────────────────────────────────────
// OAuth connect — create new account or link to existing
// ──────────────────────────────────────────────

// GET /auth/oauth-connect
router.get('/oauth-connect', (req, res) => {
  if (!req.session.pendingOAuth) {
    return res.redirect('/auth/login');
  }
  const { provider, profile } = req.session.pendingOAuth;
  res.json({
    step: 'oauth_connect',
    provider,
    suggestedDisplayName: profile.displayName,
    suggestedEmail: profile.email,
  });
});

// POST /auth/oauth-connect/new
router.post('/oauth-connect/new', async (req, res, next) => {
  try {
    const pending = req.session.pendingOAuth;
    if (!pending) return res.status(400).json({ error: 'No pending OAuth session' });

    const { username, password } = req.body;
    if (!username) return res.status(400).json({ error: 'Username is required' });

    const user = User.build({
      username,
      email: pending.profile.email || null,
      display_name: pending.profile.displayName || username,
    });

    if (password) await user.setPassword(password);
    user.linkProvider(pending.provider, pending.providerId, pending.profile);

    try {
      await user.save();
    } catch (err) {
      if (handleUniqueUserConflict(err, res)) return;
      throw err;
    }

    delete req.session.pendingOAuth;

    req.logIn(user, (err) => {
      if (err) return next(err);
      res.status(201).json({ message: 'Account created and linked', userId: user.id });
    });
  } catch (err) {
    next(err);
  }
});

// POST /auth/oauth-connect/existing
router.post('/oauth-connect/existing', async (req, res, next) => {
  try {
    const pending = req.session.pendingOAuth;
    if (!pending) return res.status(400).json({ error: 'No pending OAuth session' });

    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const user = await User.findOne({ where: { username } });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await user.verifyPassword(password);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    user.linkProvider(pending.provider, pending.providerId, pending.profile);
    await user.save();

    delete req.session.pendingOAuth;

    req.logIn(user, (err) => {
      if (err) return next(err);
      res.json({ message: 'Provider linked to existing account', userId: user.id });
    });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────────────
// Account settings (must be logged in)
// ──────────────────────────────────────────────

// POST /auth/settings/set-password
router.post('/settings/set-password', requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword) return res.status(400).json({ error: 'New password is required' });

    if (req.user.password_hash) {
      if (!currentPassword) return res.status(400).json({ error: 'Current password is required' });
      const ok = await req.user.verifyPassword(currentPassword);
      if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });
    }

    await req.user.setPassword(newPassword);
    await req.user.save();
    res.json({ message: 'Password updated' });
  } catch (err) {
    next(err);
  }
});

// POST /auth/settings/unlink
router.post('/settings/unlink', requireAuth, async (req, res, next) => {
  try {
    const { provider, providerId } = req.body;
    if (!provider || !providerId) {
      return res.status(400).json({ error: 'provider and providerId are required' });
    }

    if (!req.user.canUnlink(provider, providerId)) {
      return res.status(400).json({ error: 'Cannot unlink: no other login method available' });
    }

    req.user.unlinkProvider(provider, providerId);
    await req.user.save();
    res.json({ message: 'Provider unlinked' });
  } catch (err) {
    next(err);
  }
});

// POST /auth/settings/update-profile
router.post('/settings/update-profile', requireAuth, async (req, res, next) => {
  try {
    const { displayName, away, away_msg } = req.body;
    if (displayName) req.user.display_name = displayName;
    const awayChanged = away !== undefined && away !== req.user.away;
    if (away !== undefined) req.user.away = away;
    if (away_msg !== undefined) req.user.away_msg = away_msg;
    await req.user.save();

    // Sync Redis presence state + broadcast if away toggled. Done inside the
    // per-user presence mutex so it cannot race a concurrent WS presence
    // message that would otherwise read stale prevFinalPresence and suppress
    // the broadcast. Spec: away overrides online/idle.
    if (awayChanged) {
      const userId = req.user.id;
      await withUserPresenceLock(userId, async () => {
        let finalPresence = away ? 'away' : 'online';
        const raw = await redisClient.hGet(`users:${userId}`, 'body');
        if (raw) {
          const redisUser = JSON.parse(raw);
          // Preserve per-conn idle/online state across the toggle:
          //   away=true  — remember each conn's current presence in `base`,
          //                then set presence='away'
          //   away=false — restore each conn's presence from `base`
          // Legacy entries without `base` fall back to 'online'.
          for (const cid of Object.keys(redisUser.conns)) {
            const c = redisUser.conns[cid];
            if (away) {
              if (c.presence !== 'away') c.base = c.presence;
              c.presence = 'away';
            } else {
              const restore = (c.base === 'idle' || c.base === 'online') ? c.base : 'online';
              c.presence = restore;
              c.base = restore;
            }
          }
          // Recompute final presence using the spec priority: away > online > idle
          finalPresence = 'idle';
          for (const cid of Object.keys(redisUser.conns)) {
            const p = redisUser.conns[cid].presence;
            if (p === 'away') { finalPresence = 'away'; break; }
            if (p === 'online') finalPresence = 'online';
          }
          redisUser.presence = finalPresence;
          await redisClient.hSet(`users:${userId}`, 'body', JSON.stringify(redisUser));
        }

        // Notify the user's own sessions (local + cross-server) so their UIs
        // can flip state. Today only the WS-driven path did this.
        notifyUserAwayFrame(userId, away ? 'away' : 'unaway');

        // Broadcast presence.changed to every other connected user. `finalPresence`
        // reflects the recomputed state (so unaway correctly reports 'idle' when
        // every remaining conn was idle before the away toggle).
        broadcastToAllConnected({
          type: 'presence.changed',
          userId,
          presence: finalPresence,
        }, { excludeUserId: userId });
      });
    }

    res.json({ message: 'Profile updated' });
  } catch (err) {
    next(err);
  }
});

// POST /auth/settings/avatar  { url: '/uploads/<filename>' }
router.post('/settings/avatar', requireAuth, async (req, res, next) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });
    const oldAvatar = req.user.avatar;
    req.user.avatar = url;
    await req.user.save();

    // Remove old avatar (ignore failure)
    try {
      await minioClient.removeObject(BUCKET, oldAvatar);
    }
    catch (err) {}

    res.json({ url });
  } catch (err) {
    next(err);
  }
});



// GET /auth/generate-ws-token
router.get('/generate-ws-token', requireAuth, async (req, res, next) => {
  try {
    const token = jwt.sign({ id: req.user.id }, process.env.JWT_SECRET, { expiresIn: 60 });
    return res.json({token});
  }
  catch (err) {
    next(err);
  }
});

module.exports = router;
