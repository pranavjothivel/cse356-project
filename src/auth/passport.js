const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const GitHubStrategy = require('passport-github2').Strategy;
const { Issuer, Strategy: OidcStrategy } = require('openid-client');
const User = require('../models/User');

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findByPk(id);
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
