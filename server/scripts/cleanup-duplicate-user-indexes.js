#!/usr/bin/env node
/**
 * One-time maintenance: drop accumulated duplicate unique indexes on users.username
 * and users.email that were created by Sequelize's sync({ alter: true }) bug.
 *
 * Before running, the prod DB has indexes like:
 *   users_username_key, users_username_key1, users_username_key2, ..., users_username_key182
 *   users_email_key,    users_email_key1,    users_email_key2,    ..., users_email_key182
 *
 * This script keeps the canonical `users_username_key` / `users_email_key` and
 * drops every numbered duplicate inside a single transaction. It is idempotent:
 * running it again after cleanup is a no-op.
 *
 * Usage (from server/):
 *   NODE_ENV=production node scripts/cleanup-duplicate-user-indexes.js
 */
require('dotenv').config();
const sequelize = require('../src/db');

const BASE_INDEXES = ['users_username_key', 'users_email_key'];
// Match exactly <base>N where N is one or more digits — e.g. users_username_key1, users_username_key182.
const DUPLICATE_RE = /^(users_username_key|users_email_key)\d+$/;

async function main() {
  await sequelize.authenticate();
  console.log(`[cleanup] connected to ${process.env.DATABASE_URL ? 'DATABASE_URL' : 'default DB'}`);

  const [rows] = await sequelize.query(
    `SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'users'
      ORDER BY indexname`
  );
  const allIndexes = rows.map(r => r.indexname);
  console.log(`[cleanup] found ${allIndexes.length} indexes on public.users`);

  const duplicates = allIndexes.filter(name => DUPLICATE_RE.test(name));
  if (duplicates.length === 0) {
    console.log('[cleanup] no duplicate indexes to drop — nothing to do.');
    await sequelize.close();
    return;
  }
  console.log(`[cleanup] will drop ${duplicates.length} duplicate indexes (keeping ${BASE_INDEXES.join(', ')})`);

  const t = await sequelize.transaction();
  try {
    for (const name of duplicates) {
      // Identifier is validated by the regex above, so interpolation is safe.
      await sequelize.query(`DROP INDEX IF EXISTS "${name}"`, { transaction: t });
    }
    await t.commit();
    console.log(`[cleanup] dropped ${duplicates.length} indexes.`);
  } catch (err) {
    await t.rollback();
    throw err;
  }

  const [after] = await sequelize.query(
    `SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'users'
      ORDER BY indexname`
  );
  console.log('[cleanup] remaining indexes on users:');
  for (const row of after) console.log('  -', row.indexname);

  await sequelize.close();
}

main().catch(err => {
  console.error('[cleanup] failed:', err);
  process.exit(1);
});
