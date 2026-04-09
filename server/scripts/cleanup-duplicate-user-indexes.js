#!/usr/bin/env node
/**
 * One-time maintenance: drop accumulated duplicate unique constraints on
 * users.username and users.email that were created by Sequelize's
 * sync({ alter: true }) bug.
 *
 * Before running, the prod DB has constraints like:
 *   users_username_key, users_username_key1, users_username_key2, ..., users_username_key182
 *   users_email_key,    users_email_key1,    users_email_key2,    ..., users_email_key182
 *
 * Each one is a UNIQUE CONSTRAINT backed by an index of the same name. You
 * cannot DROP INDEX on these directly — Postgres requires ALTER TABLE ...
 * DROP CONSTRAINT, which also drops the backing index.
 *
 * This script keeps the canonical `users_username_key` / `users_email_key`
 * constraints and drops every numbered duplicate inside a single
 * transaction. It is idempotent: running it again after cleanup is a no-op.
 *
 * Usage (from server/):
 *   NODE_ENV=production node scripts/cleanup-duplicate-user-indexes.js
 */
require('dotenv').config();
const sequelize = require('../src/db');

const BASE_CONSTRAINTS = ['users_username_key', 'users_email_key'];
// Match exactly <base>N where N is one or more digits — e.g. users_username_key1, users_username_key182.
const DUPLICATE_RE = /^(users_username_key|users_email_key)\d+$/;

async function main() {
  await sequelize.authenticate();
  console.log(`[cleanup] connected to ${process.env.DATABASE_URL ? 'DATABASE_URL' : 'default DB'}`);

  // pg_constraint is the source of truth — the duplicates are UNIQUE constraints,
  // and dropping each via ALTER TABLE also drops its backing index.
  const [rows] = await sequelize.query(
    `SELECT conname
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'users' AND c.contype = 'u'
      ORDER BY conname`
  );
  const allConstraints = rows.map(r => r.conname);
  console.log(`[cleanup] found ${allConstraints.length} UNIQUE constraints on public.users`);

  const duplicates = allConstraints.filter(name => DUPLICATE_RE.test(name));
  if (duplicates.length === 0) {
    console.log('[cleanup] no duplicate constraints to drop — nothing to do.');
    await sequelize.close();
    return;
  }
  console.log(`[cleanup] will drop ${duplicates.length} duplicate constraints (keeping ${BASE_CONSTRAINTS.join(', ')})`);

  const t = await sequelize.transaction();
  try {
    for (const name of duplicates) {
      // Identifier is validated by the regex above, so interpolation is safe.
      await sequelize.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS "${name}"`, { transaction: t });
    }
    await t.commit();
    console.log(`[cleanup] dropped ${duplicates.length} constraints (and their backing indexes).`);
  } catch (err) {
    await t.rollback();
    throw err;
  }

  const [after] = await sequelize.query(
    `SELECT conname
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'users' AND c.contype = 'u'
      ORDER BY conname`
  );
  console.log('[cleanup] remaining UNIQUE constraints on users:');
  for (const row of after) console.log('  -', row.conname);

  const [idxRows] = await sequelize.query(
    `SELECT count(*)::int AS n FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'users'`
  );
  console.log(`[cleanup] total indexes on users now: ${idxRows[0].n}`);

  await sequelize.close();
}

main().catch(err => {
  console.error('[cleanup] failed:', err);
  process.exit(1);
});
