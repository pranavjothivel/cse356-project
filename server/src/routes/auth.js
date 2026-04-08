const express = require('express');
const router = express.Router();
const passport = require('passport');
const { Op } = require('sequelize');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');

const User = require('../models/User');
const { upload, minioClient } = require('../upload');

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Not authenticated' });
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
          res.redirect(process.env.FRONTEND_URL + "/");
        });
      }

      if (info?.message === 'pending_link' && req.session.pendingOAuth) {
        return req.session.save(() => {
          res.redirect(process.env.FRONTEND_URL + "/login?oauth=true");
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

    const orClauses = [{ username }];
    if (email) orClauses.push({ email });
    const existing = await User.findOne({ where: { [Op.or]: orClauses } });
    if (existing) {
      return res.status(409).json({ error: 'Username or email already taken' });
    }

    const user = User.build({ username, email: email || null, display_name: username });
    await user.setPassword(password);
    await user.save();

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

    const existing = await User.findOne({ where: { username } });
    if (existing) return res.status(409).json({ error: 'Username already taken' });

    const user = User.build({
      username,
      email: pending.profile.email || null,
      display_name: pending.profile.displayName || username,
    });

    if (password) await user.setPassword(password);
    user.linkProvider(pending.provider, pending.providerId, pending.profile);
    await user.save();

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
    if (away !== undefined) req.user.away = away;
    if (away_msg) req.user.away_msg = away_msg;
    await req.user.save();
    res.json({ message: 'Profile updated' });
  } catch (err) {
    next(err);
  }
});

// POST /auth/settings/avatar
router.post('/settings/avatar', requireAuth, upload.single('image'), async (req, res, next) => {
  if (!req.file) {
    return res.sendStatus(400);
  }
  
  const bucketName = "images";

  const objectName = `${req.user.id}/${crypto.randomUUID() + path.extname(req.file.originalname)}`;

  const exists = await minioClient.bucketExists(bucketName);
  if (!exists) {
    return res.sendStatus(500);
  }

  // Destroy current avatar if it is not the default ('1')
  if (req.user.avatar !== '1') {
    await minioClient.removeObject(bucketName, req.user.avatar);
  }

  await minioClient.putObject(bucketName, objectName, req.file.buffer);

  req.user.avatar = objectName;
  req.user.save();
  return res.json({filename: objectName});
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
