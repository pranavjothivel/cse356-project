// Redis clients. Separate TCP connections to the same REDIS_URL so a slow
// command on one (e.g. a big HGET on users:[id]) doesn't head-of-line-block
// fast ones (session lookup, cache GET) running through the same node-redis
// client.
//
//   redisClient    — connect-redis sessions
//   cacheClient    — GET/SET/DEL for user/message/member caches
//   presenceClient — HGET/HSET/DEL/multi on users:[id] presence hashes
//   lockClient     — simple-redis-mutex SET NX PX + EVALSHA + pub/sub. Isolated
//                    so a release-stampede on a hot user's lock can't saturate
//                    the session client and cascade to every authed request.
//
// (ws.js separately maintains publishClient/subClient against REDIS_PUBLISH_URL
// for cross-node broadcast pub/sub.)
const { createClient } = require('redis');
const { lock: rawLock } = require('simple-redis-mutex');

const url = process.env.REDIS_URL;

function makeClient(name) {
  const c = createClient({ url });
  c.on('error', err => console.log(`Redis ${name} client error`, err));
  c.on('ready', () => console.log(`Redis ${name} client connected`));
  // Fire-and-forget connect — the node-redis library queues commands until
  // the connection is ready, so callers don't need to await.
  c.connect();
  return c;
}

const redisClient    = makeClient('redisClient');
const cacheClient    = makeClient('cacheClient');
const presenceClient = makeClient('presenceClient');
const lockClient     = makeClient('lockClient');

// Mutex traffic always runs on lockClient so a release-stampede on a hot
// user's lock can't saturate the session/cache clients.
function lock(key, opts) {
  return rawLock(lockClient, key, opts);
}

module.exports = { redisClient, cacheClient, presenceClient, lockClient, lock };
