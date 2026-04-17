# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run server (production)
npm start

# Run server with auto-restart on file changes (development)
npm run dev
```

No test runner is configured yet. No linter is configured yet.

## Environment Variables

A `.env` file is required. Expected variables:

```
DATABASE_URL=          # PostgreSQL connection string
SESSION_SECRET=        # Secret for express-session
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_CALLBACK_URL=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_CALLBACK_URL=
OIDC_ISSUER=           # https://infra-auth.cse356.compas.cs.stonybrook.edu/realms/oauth
OIDC_CLIENT_ID=        # web-service
OIDC_CLIENT_SECRET=    # web-service-secret
OIDC_CALLBACK_URL=
NODE_ENV=              # development | production
PORT=                  # defaults to 3000
```

## Architecture

**Stack:** Node.js + Express 5, PostgreSQL via Sequelize ORM, Passport.js for auth, sessions stored in Postgres via `connect-pg-simple`.

**Entry point:** `src/app.js` — bootstraps middleware, mounts routes, syncs DB, then starts the server. `sequelize.sync()` runs with `alter: true` in non-production only (it's disabled in production because Sequelize's alter algorithm re-adds unique indexes on every boot). Production schema changes go in `server/scripts/migrations/` and are applied manually — see the README there.

**Auth system (`src/auth/passport.js`, `src/routes/auth.js`):**
- Four strategies: Local, Google OAuth2, GitHub OAuth2, Course OIDC (Keycloak via `openid-client`)
- `setupOidcStrategy()` is async (requires OIDC discovery) — called at startup in `app.js` before `listen`
- Multi-provider accounts: `User.providers` is a JSONB array of `{ provider, provider_id, display_name, email }` objects. Provider linking/unlinking is managed via `User.linkProvider()` / `User.unlinkProvider()` instance methods
- OAuth flow for new users: passport callback stores `req.session.pendingOAuth`, redirects to `/auth/oauth-connect`, then user either creates a new account (`POST /auth/oauth-connect/new`) or links to an existing account (`POST /auth/oauth-connect/existing`)
- Sessions are per-login: `POST /auth/logout` destroys only the current session row, leaving other sessions intact
- `passReqToCallback: true` is set on all OAuth strategies so they can check `req.user` (for linking while already logged in) and write to `req.session.pendingOAuth`

**User model (`src/models/User.js`):**
- UUID primary key, `username` and `email` both optional/nullable (to support OAuth-only accounts)
- `password_hash` is nullable; `verifyPassword` returns `false` if null
- `canUnlink()` guards against leaving an account with no login method

**Database:** Single `users` table + Postgres `sessions` table (auto-created by `connect-pg-simple`). All timestamps use `underscored: true` Sequelize convention.

## What's Not Yet Built

The auth layer is complete. Still needed per the project spec: communities, channels, direct conversations, real-time messaging (WebSocket/SSE), presence system, message search (full-text), read state tracking, file/image attachments, and the frontend UI.
