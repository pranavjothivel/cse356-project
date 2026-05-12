# Schema migrations

Production uses `sequelize.sync()` **without** `alter: true`, so Sequelize will
only create tables that don't exist yet. It will **not** apply changes to
existing tables (new columns, changed types, new indexes, etc.).

Any schema change that affects an existing table must be shipped as a numbered
SQL file in this directory and applied manually against production after
deploy.

## Why not `sequelize-cli`?

`sequelize-cli` is the standard Sequelize migration runner but adds a tracking
table, a directory layout, and boot-time semantics we don't need for a
short-lived project. The manual-SQL workflow below is deliberately minimal;
graduate to `sequelize-cli` (or `umzug`) if schema changes become frequent.

## Why not `sync({ alter: true })` in production?

Because Sequelize's `alter` algorithm can't detect that an existing unique
index is equivalent to `unique: true` in a model definition. Every boot adds
a **new** unique index with a numbered suffix — over 182 deploys we ended up
with `users_username_key`, `users_username_key1`, ..., `users_username_key182`.
This bloats the table and makes every insert progressively slower.

Dev still uses `alter: true` for convenience (see `src/app.js`).

## Layout

- `0007-baseline-schema.sql` — `pg_dump --schema-only` snapshot of the
  production `cse356` database (8 tables, 9 indexes, 3 extensions: pg_prewarm,
  pg_stat_statements, pg_trgm). Captured directly from `group1-db-psql-01`
  for reproducibility; reflects the cumulative effect of every prior
  migration plus the duplicate `*_name_key{N}` artifacts the `alter: true`
  bug left behind in earlier boots.
- `legacy/0002-…` through `legacy/0006-…` — pre-baseline migrations,
  already applied to the production DB. Kept for history; new bootstraps
  should run `0007-baseline-schema.sql` alone.

## Naming

```
NNNN-short-description.sql
```

`NNNN` is a zero-padded sequence number. The number must increase
monotonically — pick the next available number after the highest in this
directory (currently `0007`) when you add a file.

## Example

```sql
-- 0001-add-bio-to-users.sql
-- Adds a nullable `bio` TEXT column to the users table.
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;
```

Write every migration so that re-running it is a no-op (`IF NOT EXISTS`,
`IF EXISTS`, `ON CONFLICT DO NOTHING`, etc.). We don't have a tracking table
yet, so idempotency is your safety net.

## Applying a migration

From your laptop (replace `<node>` with any app node IP — the DB is shared):

```bash
scp -i ~/.ssh/<deploy-key> server/scripts/migrations/NNNN-*.sql \
    deploy@<node>:/tmp/
ssh -i ~/.ssh/<deploy-key> deploy@<node> \
    'psql "$DATABASE_URL" -f /tmp/NNNN-*.sql'
```

Or, if you're running the migration as Node (e.g. to reuse existing model
logic), put it in `server/scripts/` alongside `cleanup-duplicate-user-indexes.js`
and run it the same way:

```bash
ssh deploy@<node> 'cd /srv/app && NODE_ENV=production node scripts/<script>.js'
```
