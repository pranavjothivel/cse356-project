const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const GitHubStrategy = require('passport-github2').Strategy;
const { Issuer, custom, Strategy: OidcStrategy } = require('openid-client');
const User = require('../models/User');
const redisClient = require('../redis');

const USER_CACHE_TTL = 60; // seconds

// Course provider sometimes takes very long to respond, so set timeout to 20 sec instead of 3.5
custom.setHttpOptionsDefaults({
  timeout: 20000,
});

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const cached = await redisClient.get(`user:${id}`);
    if (cached) {
      // Rehydrate to a Sequelize instance so callers that mutate via
      // `req.user.save()` / `req.user.linkProvider()` / `.verifyPassword()`
      // continue to work transparently. `isNewRecord: false` makes save()
      // issue an UPDATE on PK rather than INSERT.
      return done(null, User.build(JSON.parse(cached), { isNewRecord: false }));
    }
    const user = await User.findByPk(id);
    if (user) {
      // Fire-and-forget cache write — don't block the request on Redis.
      redisClient.set(`user:${id}`, JSON.stringify(user.toJSON()), { EX: USER_CACHE_TTL })
        .catch(err => console.warn('user cache set failed:', err.message));
    }
    done(null, user);
  } catch (err) {
    done(err);
  }
});

// ──────────────────────────────────────────────
// Local strategy
// ──────────────────────────────────────────────
passport.use(new LocalStrategy(async (username, password, done) => {
  try {
    const user = await User.findOne({ where: { username } });
    if (!user) return done(null, false, { message: 'Invalid credentials' });
    const ok = await user.verifyPassword(password);
    if (!ok) return done(null, false, { message: 'Invalid credentials' });
    return done(null, user);
  } catch (err) {
    return done(err);
  }
}));

// ──────────────────────────────────────────────
// Helper: find existing account by OAuth provider
// ──────────────────────────────────────────────
const { Op } = require('sequelize');

async function findByProvider(provider, providerId) {
  // JSONB containment query: providers @> '[{"provider":"...","provider_id":"..."}]'
  return User.findOne({
    where: {
      providers: {
        [Op.contains]: [{ provider, provider_id: providerId }],
      },
    },
  });
}

// ──────────────────────────────────────────────
// Google
// ──────────────────────────────────────────────
passport.use(new GoogleStrategy(
  {
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL,
    passReqToCallback: true,
  },
  async (req, _accessToken, _refreshToken, profile, done) => {
    try {
      const providerId = profile.id;
      const providerProfile = {
        displayName: profile.displayName,
        email: profile.emails?.[0]?.value,
      };

      if (req.user) {
        req.user.linkProvider('google', providerId, providerProfile);
        await req.user.save();
        return done(null, req.user);
      }

      const existing = await findByProvider('google', providerId);
      if (existing) return done(null, existing);

      req.session.pendingOAuth = { provider: 'google', providerId, profile: providerProfile };
      return done(null, false, { message: 'pending_link' });
    } catch (err) {
      return done(err);
    }
  }
));

// ──────────────────────────────────────────────
// GitHub
// ──────────────────────────────────────────────
passport.use(new GitHubStrategy(
  {
    clientID: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    callbackURL: process.env.GITHUB_CALLBACK_URL,
    passReqToCallback: true,
  },
  async (req, _accessToken, _refreshToken, profile, done) => {
    try {
      const providerId = String(profile.id);
      const providerProfile = {
        displayName: profile.displayName || profile.username,
        email: profile.emails?.[0]?.value,
      };

      if (req.user) {
        req.user.linkProvider('github', providerId, providerProfile);
        await req.user.save();
        return done(null, req.user);
      }

      const existing = await findByProvider('github', providerId);
      if (existing) return done(null, existing);

      req.session.pendingOAuth = { provider: 'github', providerId, profile: providerProfile };
      return done(null, false, { message: 'pending_link' });
    } catch (err) {
      return done(err);
    }
  }
));

// ──────────────────────────────────────────────
// Course OIDC (Keycloak)
// ──────────────────────────────────────────────
async function setupOidcStrategy() {
  const issuer = await Issuer.discover(process.env.OIDC_ISSUER);
  const client = new issuer.Client({
    client_id: process.env.OIDC_CLIENT_ID,
    client_secret: process.env.OIDC_CLIENT_SECRET,
    redirect_uris: [process.env.OIDC_CALLBACK_URL],
    response_types: ['code'],
  });

  passport.use('oidc', new OidcStrategy(
    { client, passReqToCallback: true },
    async (req, _tokenSet, userinfo, done) => {
      try {
        const providerId = userinfo.sub;
        const providerProfile = {
          displayName: userinfo.name || userinfo.preferred_username,
          email: userinfo.email,
        };

        if (req.user) {
          req.user.linkProvider('oidc', providerId, providerProfile);
          await req.user.save();
          return done(null, req.user);
        }

        const existing = await findByProvider('oidc', providerId);
        if (existing) return done(null, existing);

        req.session.pendingOAuth = { provider: 'oidc', providerId, profile: providerProfile };
        return done(null, false, { message: 'pending_link' });
      } catch (err) {
        return done(err);
      }
    }
  ));
}

module.exports = { passport, setupOidcStrategy };
