const crypto = require('crypto');
const jwt = require('jsonwebtoken');

/* lock is used as a mutex that works even between nodes
   lock releases after 200ms in case locker failed to release, poll every 5ms

   Currently all local user processing is done at the same time as redis user processing, so 
   each block is wrapped in lock (replacing withUserPresenceLock callbacks)

   Usage goes like this:
   let release = async () => {}; // In case of error, since we don't know the cause, make sure release is always callable
   try {
    [processing not involving redis or local users]
    release = await lock(redisClient, `lock:users:${id}`, lockOptions);
    [some processing of redis and/or local users (mutex not necessary for read-only operations)]
    await release();
   }
   catch (err) {
    [some logic]
    try { await release(); } catch (e) {}
  }
*/
const lockOptions = { timeout: 500, pollingInterval: 50 };

const { Op } = require('sequelize');
const User = require('./models/User');
const CommunityMember = require('./models/CommunityMember');
const ConversationParticipant = require('./models/ConversationParticipant');
const { redisClient, presenceClient, lock } = require('./redis');
const { createClient } = require('redis');

// Identifier that should be sent when publishing through Redis
const serverId = crypto.randomUUID();

// True when this worker hosts a WebSocket server (i.e. has local connections
// in the `users` Map). On api_only nodes (WORKER_ROLE=http) the local users
// Map is always empty, so deliverLocal calls are pure overhead — skip them.
const HAS_LOCAL_WS = process.env.WORKER_ROLE !== 'http';


const publishClient = createClient({ url: process.env.REDIS_PUBLISH_URL });
publishClient.on('error', err => console.log('Redis Client Error', err));
// subClient is dedicated to receiving updates published by other instances.
// Connection + subscription are awaited in initWS() before the HTTP server
// starts accepting requests, so presence fanout cannot be silently missed
// during the startup window.
const subClient = publishClient.duplicate();
subClient.on('error', (err) => console.error('Redis subscriber error:', err));


function handleSubMessage(raw) {
  try {
    const envelope = JSON.parse(raw);
    // Ignore messages you published
    if (envelope.serverId === serverId) return;

    // ── INSTRUMENTATION (transient, revert as one commit) ──
    // t_recv = the moment this worker's main thread enters handleSubMessage
    // for this envelope. publishedAt was stamped by the publisher just
    // before publishClient.publish(). Difference = end-to-end pubsub
    // round-trip (publish enqueue → redis-02 main loop → write to
    // subscriber socket → node-redis client decode → into JS callback).
    const t_recv = Date.now();
    const publishedAt = envelope.publishedAt;
    if (publishedAt) bucketAdd(fanoutLatency.publishToRecv, t_recv - publishedAt);

    const msg = envelope.msg;

    if (msg.type === "presence") {
      let conns = users.get(msg.id);
      if (!conns) return; // Nothing to do if no connections

      if (msg.value === "away") {
        Object.keys(conns).forEach((k) => {
          try { conns[k].send("away"); } catch (e) { /* ignore broken socket */ }
        });
      }
      else if (msg.value === "unaway") {
        Object.keys(conns).forEach((k) => {
          try { conns[k].send("unaway"); } catch (e) { /* ignore broken socket */ }
        });
      }
      // Single-pass send loop — measure once at the end.
      const t_send = Date.now();
      bucketAdd(fanoutLatency.recvToSend, t_send - t_recv);
      if (publishedAt) bucketAdd(fanoutLatency.publishToSend, t_send - publishedAt);
    }
    else if (msg.type === "fanout") {
      let userIds = msg.userIds;
      if (userIds.length === 0 && msg.userIdsBuf) {
        userIds = bufferToUUIDs(Buffer.from(msg.userIdsBuf, 'base64'));
      }
      // Generic per-user fanout published from any worker. Deliver locally only.
      // Defer + chunk like fanout_all does — without yields, a burst of N
      // queued pub/sub messages drains synchronously inside the subscribe
      // callback, blocking the event loop for N × per-message-time. With
      // chunking, message processing interleaves with everything else.
      setImmediate(() => {
        deliverLocalChunked(userIds, msg.payload, t_recv, publishedAt).catch(err => console.error('fanout error:', err));
      });
    }
    else if (msg.type === "fanout_all") {
      // Defer + chunk so message fanouts queued behind a large presence
      // broadcast can interleave instead of waiting for the full ~750-conn
      // loop to finish.
      const data = typeof msg.payload === 'string' ? msg.payload : JSON.stringify(msg.payload);
      setImmediate(() => {
        fanoutAllChunked(data, msg.excludeUserId, t_recv, publishedAt).catch(err => console.error('fanout_all error:', err));
      });
    }
  }
  catch (err) {
    console.error('Redis subscriber handler error:', err);
  }
}

function bufferToUUIDs(buffer) {
  const uuids = [];

  for (let i = 0; i < buffer.length; i += 16) {
    const hex = buffer.slice(i, i + 16).toString('hex');

    // reinsert dashes into UUID format
    const uuid = [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20)
    ].join('-');

    uuids.push(uuid);
  }

  return uuids;
}

/**
 * Connect the Redis publish client. MUST be called on every worker that
 * runs REST handlers (POST /api/messages, conversations/*, channels/*),
 * because broadcastToUsers() calls publishClient.publish() fire-and-forget.
 * On a never-connected client, that call returns silently without sending,
 * so cross-node WS broadcasts disappear into a black hole.
 *
 * Cheap: one TCP connection to Redis, no subscription overhead. Safe to
 * call on api_only nodes that never accept WS connections themselves.
 */
async function initWSPublisher() {
  await publishClient.connect();
  console.log("Redis publisher connected");
}

/**
 * Connect the Redis subscriber and register the cross-node fanout handler.
 * Only needed on workers that run a WebSocket.Server — otherwise we'd
 * receive every cluster broadcast just to iterate an empty local users Map
 * and discard. ~10MB/sec at our scale, worth skipping on api_only nodes.
 *
 * Must be awaited from app startup before the HTTP server begins accepting
 * requests — otherwise fanout_all messages published by other workers
 * during the startup window would be dropped.
 */
async function initWSSubscriber() {
  await subClient.connect();
  // Per-worker channel for the WS message-delivery hot path. broadcastToUsers
  // looks up which worker(s) hold each recipient (via presenceClient) and
  // publishes one small envelope per destination worker, so a worker only
  // receives `fanout` envelopes whose recipient list intersects its local
  // `users` Map. Per-publish redis-02 work no longer scales with cluster size.
  await subClient.subscribe(`messages:${serverId}`, handleSubMessage);
  // Cluster-wide channel for `presence` and `fanout_all` — these legitimately
  // need every WS worker to receive them.
  await subClient.subscribe('messages:global', handleSubMessage);
  console.log("Redis subscriber connected");
}

// ──────────────────────────────────────────────
// Per-user presence mutex
// ──────────────────────────────────────────────
// Multiple code paths mutate users:<id> in Redis via read-modify-write:
//   - WS 'presence' message handler
//   - WS 'close' handler
//   - REST POST /auth/settings/update-profile (via withUserPresenceLock)
// Without serialization, two in-flight mutations for the same user can both
// read the same prevFinalPresence and one of their presence.changed broadcasts
// gets suppressed because prev == new. The mutex is per-user so cross-user
// events never block each other.
const presenceLocks = new Map();
function withUserPresenceLock(userId, fn) {
  const prev = presenceLocks.get(userId) || Promise.resolve();
  const next = prev.then(fn, fn).finally(() => {
    // Clean up once the chain tail equals this entry — avoids unbounded growth.
    if (presenceLocks.get(userId) === next) presenceLocks.delete(userId);
  });
  presenceLocks.set(userId, next);
  return next;
}



/*
  Current structure in redis:

  HGET users:[id] body
  HSET users:[id] body [string representation of body]
  body:
    {
      presence - final presence used for display - "online" if any connection online, "away" if any away, "idle" if all idle
      conns: {
        [connId]: { presence: "online" or "idle" or "away" }
        [another connId]: { presence }
        ...
      }
    }
    
  GET conns:[connId]
  SET conns:[connId] 1 EX 120
  Only care about existence - expiration needed so connections associated with downed server eventually disappear
*/



/**
 * Maps user id to an object of ws connections for that user
 * 
 * users: id -> { connId1: ws1, connId2: ws2, ... }
 * 
 */
const users = new Map();

/**
 * Maps connection id to an object containing the ws connection and other data
 * 
 * connections: connId -> { userId, ws }
 * 
 */
const connections = new Map();


// Ping/pong disabled — confirmed independently causes latency spikes
// via Redis SET contention on the shared delivery client.
// To re-enable, use a dedicated Redis client for conns: writes.
// See PR #120 / #128 for test results.


/**
 * Deliver a payload to every local WS connection of the given user ids.
 * Used by both the Redis fanout subscriber and the local-side of broadcastToUsers.
 */
function deliverLocal(userIds, payload) {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  for (const userId of userIds) {
    const conns = users.get(userId);
    if (!conns) continue;
    for (const cid of Object.keys(conns)) {
      try { conns[cid].send(data); } catch (e) { /* ignore broken socket */ }
    }
  }
}

/**
 * Same as deliverLocal but yields back to the event loop every FANOUT_CHUNK
 * sends so a burst of subscriber-side fanouts (e.g. 100+ pub/sub messages
 * queued during a brief pause) can interleave instead of stalling the worker
 * event loop for the entire drain. Mirrors `fanoutAllChunked` for the per-user
 * fanout path. Caller is expected to invoke via setImmediate so the first
 * iteration is also off the pub/sub callback's tick.
 */
async function deliverLocalChunked(userIds, payload, t_recv, publishedAt) {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  let count = 0;
  for (const userId of userIds) {
    const conns = users.get(userId);
    if (!conns) continue;
    for (const cid of Object.keys(conns)) {
      try { conns[cid].send(data); } catch (e) { /* ignore broken socket */ }
      if (++count % FANOUT_CHUNK === 0) {
        await new Promise(setImmediate);
      }
    }
  }
  // Instrumentation: record one measurement per envelope at full-deliver time.
  // Includes any setImmediate yields, so high values here mean either many
  // recipients or contention with other event-loop work — both worth knowing.
  if (typeof t_recv === 'number') {
    const t_send = Date.now();
    bucketAdd(fanoutLatency.recvToSend, t_send - t_recv);
    if (publishedAt) bucketAdd(fanoutLatency.publishToSend, t_send - publishedAt);
  }
}


let broadcastMetrics = { numMessages: 0, sumProcessing: 0 };
function logBroadcastMetrics() {
  let avg = 0;
  if (broadcastMetrics.numMessages > 0) avg = broadcastMetrics.sumProcessing / broadcastMetrics.numMessages;
  console.log(`Message Broadcast Metrics: ${broadcastMetrics.numMessages} broadcasts, ${avg} ms average time to broadcast`);
}
setInterval(logBroadcastMetrics, 30000);

// ──────────────────────────────────────────────
// Fanout latency profiling (transient — revert as one commit)
// ──────────────────────────────────────────────
// Per-envelope timing of the cross-node WS broadcast pipeline:
//   publishToRecv = subscriber's handleSubMessage entry - publisher's Date.now()
//   recvToSend    = end of local deliver (last ws.send returns) - handleSubMessage entry
//   publishToSend = end of local deliver - publisher's Date.now()
// Publisher-side timestamp is added to envelopes as `publishedAt`. Subscribers
// without a publishedAt field skip publishToRecv/publishToSend.
//
// Cost: ~3 Date.now() calls per envelope + bucket inserts (constant). Memory:
// 3 × 512-sample ring buffer ≈ 12 KB per worker. Log line every 30s on the
// same interval as the existing broadcast metric.
//
// Clocks are synced via chrony (~±1 ms across Linode hosts). Sub-ms-accurate
// readings will be noisy; ms-granularity readings are reliable. Negative values
// (clock skew) are rejected so they don't poison min/avg.
function makeBucket(cap = 512) {
  return { count: 0, sum: 0, min: Infinity, max: 0, samples: [], cap };
}
function bucketAdd(b, v) {
  // Reject impossible values: negatives (clock skew between publisher and
  // subscriber) and > 60 s (almost certainly a bug, e.g. accidentally adding
  // an absolute timestamp instead of a delta).
  if (typeof v !== 'number' || v < 0 || v > 60000) return;
  b.count++;
  b.sum += v;
  if (v < b.min) b.min = v;
  if (v > b.max) b.max = v;
  if (b.samples.length < b.cap) b.samples.push(v);
  else b.samples[b.count % b.cap] = v;
}
function bucketReset(b) {
  b.count = 0; b.sum = 0; b.min = Infinity; b.max = 0; b.samples.length = 0;
}
function bucketPct(b, p) {
  if (b.samples.length === 0) return 0;
  const sorted = b.samples.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}
const fanoutLatency = {
  publishToRecv: makeBucket(),
  recvToSend:    makeBucket(),
  publishToSend: makeBucket(),
};
function logFanoutLatency() {
  for (const name of Object.keys(fanoutLatency)) {
    const b = fanoutLatency[name];
    if (b.count === 0) continue;
    const avg = (b.sum / b.count).toFixed(2);
    console.log(
      `fanoutLatency.${name}: n=${b.count} avg=${avg}ms ` +
      `p50=${bucketPct(b, 0.5)}ms p95=${bucketPct(b, 0.95)}ms ` +
      `p99=${bucketPct(b, 0.99)}ms max=${b.max}ms`
    );
    bucketReset(b);
  }
}
setInterval(logFanoutLatency, 30000);

/**
 * Pack a UUID array into a tightly-binary Buffer (16 bytes each, no dashes).
 * Subscriber-side `bufferToUUIDs` reverses this. Lifted out of the per-worker
 * routing path below so the legacy dual-publish below can reuse it.
 */
function packUUIDs(uuids) {
  return Buffer.concat(uuids.map(u => Buffer.from(u.replace(/-/g, ''), 'hex')));
}

/**
 * Fan out a JSON payload to all sessions of the given user ids, across every
 * server in the cluster. Use this from REST handlers when a write needs to
 * push a real-time update (message.created, conversation.participants_changed, ...).
 *
 * Routing model:
 *   - Local sessions (this worker holds them) → `deliverLocal` synchronously.
 *   - Cross-worker sessions → look up presenceClient.users:{id}.body for every
 *     recipient, group by `c.serverId` (each conn knows which worker holds it,
 *     written in the connect path), then publish ONE small envelope per
 *     destination worker to `messages:{destServerId}`. A worker only receives
 *     `fanout` envelopes containing user-ids it actually has connected.
 *
 * Fire-and-forget against the publish path; callers don't await. The HMGET
 * pipeline adds one redis-01 round-trip (~sub-ms) but the payload going to
 * redis-02 shrinks from O(N_subscribers × len) to O(N_recipients × len), so
 * adding more WS workers stops amplifying per-publish redis-02 work.
 */
async function broadcastToUsers(userIds, payload) {
  if (!userIds || userIds.length === 0) return;
  const date1 = Date.now();

  // Stringify payload exactly once. deliverLocal already accepts string;
  // the publish envelope carries it as a string field so subscriber-side
  // workers can pass it straight to deliverLocal without re-serializing.
  const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);

  if (HAS_LOCAL_WS) deliverLocal(userIds, payloadStr);

  // Look up which worker(s) hold each recipient. One TCP round-trip via
  // MULTI regardless of recipient-list size. For users with no presence
  // entry (offline) the result is null and they get skipped — same delivery
  // outcome as pre-pass-2 (they had no local conn anywhere to deliver to).
  let bodies;
  try {
    const pipeline = presenceClient.multi();
    for (const id of userIds) pipeline.hGet(`users:${id}`, 'body');
    bodies = await pipeline.exec();
  } catch (err) {
    console.error('broadcastToUsers presence lookup failed:', err);
    bodies = [];
  }

  // Group recipients by destination worker. Multi-tab users on different
  // workers contribute one entry per distinct worker. Self-publishes to our
  // own worker are skipped — local recipients were already handled by
  // deliverLocal above.
  const byServer = new Map();   // destServerId -> [userId, ...]
  for (let i = 0; i < userIds.length; i++) {
    const raw = bodies[i];
    if (!raw) continue;
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { continue; }
    const seen = new Set();     // dedupe across this user's tabs on the same worker
    const conns = parsed.conns;
    if (!conns) continue;
    for (const cid in conns) {
      const sid = conns[cid] && conns[cid].serverId;
      if (!sid || sid === serverId || seen.has(sid)) continue;
      seen.add(sid);
      let arr = byServer.get(sid);
      if (!arr) { arr = []; byServer.set(sid, arr); }
      arr.push(userIds[i]);
    }
  }

  // One publish per destination worker. Each envelope only carries the
  // user-ids that actually live on the receiving worker, so the receiver's
  // subscribe-callback work is bounded by its share of the recipient list.
  // Single publishedAt for the whole broadcast — every per-worker envelope
  // for this call shares it, so the receiver-side recvToSend / publishToSend
  // measurements are comparable across destination workers.
  const publishedAt = Date.now();
  for (const [destServerId, ids] of byServer) {
    const buf = packUUIDs(ids);
    publishClient.publish(`messages:${destServerId}`, JSON.stringify({
      serverId,
      publishedAt,
      msg: { type: 'fanout', userIds: [], userIdsBuf: buf.toString('base64'), payload: payloadStr },
    }));
  }

  broadcastMetrics.numMessages++;
  broadcastMetrics.sumProcessing += Date.now() - date1;
}

/**
 * Send the in-band "away"/"unaway" WS frame to every session of `userId`
 * across the cluster. Used when the user's away state is changed via a path
 * that isn't already a WS message (e.g. REST POST /auth/settings/update-profile),
 * so their other tabs can flip state. Cross-server delivery happens via the
 * existing `{type:'presence'}` Redis pub/sub handler; local delivery happens
 * inline so same-node sessions aren't skipped by the `serverId` self-check.
 */
function notifyUserAwayFrame(userId, value) {
  if (value !== 'away' && value !== 'unaway') return;
  // Local delivery (skip on api_only nodes — users Map is always empty)
  if (HAS_LOCAL_WS) {
    const conns = users.get(userId);
    if (conns) {
      for (const cid of Object.keys(conns)) {
        try { conns[cid].send(value); } catch (e) { /* ignore broken socket */ }
      }
    }
  }
  // Cross-server fanout. presence frames legitimately need every WS worker
  // to receive them (any worker may hold another tab of this user), so they
  // go on the cluster-wide `messages:global` channel.
  publishClient.publish('messages:global', JSON.stringify({
    serverId,
    publishedAt: Date.now(),
    msg: { id: userId, type: 'presence', value },
  }));
}

/**
 * Fan out a JSON payload to every currently connected WS session across the cluster.
 * Used for presence.changed — we want any connected user to observe presence transitions,
 * regardless of whether they share a community or DM with the subject.
 */
function broadcastToAllConnected(payload, { excludeUserId } = {}) {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  // Cross-server fanout FIRST so other WS nodes can start work in parallel,
  // then defer + chunk local delivery so this worker's event loop stays
  // responsive to incoming message fanouts during the local send loop.
  // Carry payload as already-stringified so subscriber-side workers don't
  // re-serialize it; avoids a second JSON.stringify cluster-wide per event.
  // fanout_all genuinely needs every WS worker to deliver to its locally
  // connected users, so it lives on `messages:global`.
  publishClient.publish('messages:global', JSON.stringify({
    serverId,
    publishedAt: Date.now(),
    msg: { type: 'fanout_all', payload: data, excludeUserId: excludeUserId || null },
  }));
  if (HAS_LOCAL_WS) {
    setImmediate(() => {
      fanoutAllChunked(data, excludeUserId).catch(err => console.error('local fanout_all error:', err));
    });
  }
}

// Walks the local users Map sending `data` to every conn (optionally
// excluding excludeUserId), yielding back to the event loop every 50 sends.
// At ~750 conns per WS node, an unyielded loop blocks the event loop for
// several ms — long enough that incoming message-fanout pub/sub callbacks
// queue behind it. Yielding lets messages interleave during the long fanout.
const FANOUT_CHUNK = 50;
async function fanoutAllChunked(data, excludeUserId, t_recv, publishedAt) {
  let count = 0;
  for (const [uid, conns] of users.entries()) {
    if (excludeUserId && uid === excludeUserId) continue;
    for (const cid of Object.keys(conns)) {
      try { conns[cid].send(data); } catch (e) { /* ignore broken socket */ }
      if (++count % FANOUT_CHUNK === 0) {
        await new Promise(setImmediate);
      }
    }
  }
  if (typeof t_recv === 'number') {
    const t_send = Date.now();
    bucketAdd(fanoutLatency.recvToSend, t_send - t_recv);
    if (publishedAt) bucketAdd(fanoutLatency.publishToSend, t_send - publishedAt);
  }
}

async function getCoCommunityUserIds(userId) {
  const myCommunities = await CommunityMember.findAll({
    where: { user_id: userId },
    attributes: ['community_id'],
    raw: true,
  });
  if (myCommunities.length === 0) return [];
  const communityIds = myCommunities.map(r => r.community_id);
  const coMembers = await CommunityMember.findAll({
    where: { community_id: communityIds, user_id: { [Op.ne]: userId } },
    attributes: ['user_id'],
    raw: true,
  });
  return [...new Set(coMembers.map(r => r.user_id))];
}

/**
 * Per-worker in-process cache of presence audiences. Keyed by userId,
 * value = { audience, expires }. Audience is the union of co-community
 * members + conversation participants (computed by the uncached path
 * below). Audiences are stable on the second-to-minute timescale —
 * community joins/leaves are rare events — so a 30s TTL is a safe trade
 * for the much-larger reduction in PG load.
 *
 * Sizing math: ~1K active users × ~100 audience IDs (UUID strings, ~36B)
 * ≈ 3.6 MB per worker. Far below any threshold worth evicting at, so we
 * leave the Map unbounded and let the TTL prune naturally on next read.
 */
const presenceAudienceCache = new Map();
const PRESENCE_AUDIENCE_TTL_MS = 30_000;

/**
 * Get all user IDs who should see this user's presence changes:
 * co-community members + conversation (DM/group) partners. Cached.
 */
async function getPresenceAudienceUserIds(userId) {
  const cached = presenceAudienceCache.get(userId);
  if (cached && cached.expires > Date.now()) return cached.audience;

  const [communityUserIds, convParts] = await Promise.all([
    getCoCommunityUserIds(userId),
    ConversationParticipant.findAll({
      attributes: ['conversation_id'],
      where: { user_id: userId },
      raw: true,
    }),
  ]);

  let convUserIds = [];
  if (convParts.length > 0) {
    const convIds = convParts.map(p => p.conversation_id);
    const coParticipants = await ConversationParticipant.findAll({
      attributes: ['user_id'],
      where: { conversation_id: convIds, user_id: { [Op.ne]: userId } },
      raw: true,
    });
    convUserIds = coParticipants.map(p => p.user_id);
  }

  const audience = [...new Set([...communityUserIds, ...convUserIds])];
  presenceAudienceCache.set(userId, { audience, expires: Date.now() + PRESENCE_AUDIENCE_TTL_MS });
  return audience;
}

/**
 * Broadcast a presence.changed event. Spec only requires recipients who share
 * a community/DM/GM with the subject — but instructor confirmed sending to
 * extra users is "not wrong, just unnecessary" (Piazza). Going wide because
 * the per-event subscriber cost is much smaller than the audience-scoped
 * variant: a flat fanout_all envelope is ~100 bytes vs ~40 KB-700 KB when
 * we send the userIds list, and subscribers iterate their local users Map
 * (~few hundred entries on a WS node) instead of running bufferToUUIDs on a
 * 32k-element list. Audience-scoping (3000d2c) inflated subscriber processing
 * on the WS event loop and triggered the 13s p95 spikes; this restores the
 * cheaper per-event path the cluster ran on through 4/27-4/28.
 */
// Per-user debounce on presence broadcasts. broadcastToAllConnected fans out
// 1 frame to every locally-connected user on every WS node, so each call
// costs ~N_users sends cluster-wide. Rapid bursts (e.g. tab focus toggling
// online → idle → online in 200ms) used to fire 3 fanouts back-to-back;
// debouncing collapses them to 1 carrying the latest state. Spec-allowed
// per Piazza (Mike Ferdman: "Latest correct state should be fine, but
// there shouldn't be 'too much' of a delay between a change and when it
// gets emitted") — 250ms is well under "too much."
//
// Map keyed by userId; entry stores the latest pending presence value and
// the setTimeout handle. While an entry exists, additional calls for that
// user just overwrite `latest` and return — only the latest state is
// broadcast when the timer fires. Map drains naturally as timers fire;
// bounded by the number of users with pending events.
const presenceDebounce = new Map();
const PRESENCE_DEBOUNCE_MS = 250;

async function broadcastPresenceChange(userId, presence) {
  const existing = presenceDebounce.get(userId);
  if (existing) {
    existing.latest = presence;
    return;
  }
  const entry = { latest: presence, timer: null };
  entry.timer = setTimeout(() => {
    presenceDebounce.delete(userId);
    broadcastToAllConnected(
      { type: 'presence.changed', userId, presence: entry.latest },
      { excludeUserId: userId }
    );
  }, PRESENCE_DEBOUNCE_MS);
  presenceDebounce.set(userId, entry);
}


let wsMessageMetrics = { numMessages: 0, sumProcessing: 0 };
function updateWSMetrics(start_date) {
  let end_date = Date.now();
  wsMessageMetrics.numMessages++;
  wsMessageMetrics.sumProcessing += end_date - start_date;
}

function logWSMetrics() {
  let avg = 0;
  if (wsMessageMetrics.numMessages > 0) avg = wsMessageMetrics.sumProcessing / wsMessageMetrics.numMessages;
  console.log(`WS Message Metrics: ${wsMessageMetrics.numMessages} messages, ${avg} ms average processing time`);
}
setInterval(logWSMetrics, 30000);


const configureWSServer = (wss) => {
  wss.on('connection', async (ws, req) => {
    let connId = crypto.randomUUID();
    let id;

    ws.on('message', async (data) => {
      let date1 = Date.now();

      let release = async () => {};
      try {
        const msg = JSON.parse(data);

        if (msg.type === 'presence') {
          const newPresence = msg.value;

          if (!(newPresence === "online" || newPresence === "idle" || newPresence === "away" || newPresence === "unaway")) return;

          // Effects collected inside the lock and applied AFTER release so the
          // critical section is just hGet → mutate → hSet. Lock-wait p99 was
          // ~146 ms with ws.send loops, publish, and broadcastPresenceChange
          // all running while the lock was held; deferring them shrinks the
          // window to a single Redis read-modify-write.
          let framesToSend = null;       // [connId, "away"|"unaway"]
          let crossServerAwayFrame = false;
          let presenceChangedTo = null;  // string when finalPresence !== prev

          release = await lock(`lock:users:${id}`, lockOptions);
          const raw = await presenceClient.hGet(`users:${id}`, "body");
          if (!raw) {
            await release();
            updateWSMetrics(date1);
            return; // connection closed between reads
          }
          const redisUser = JSON.parse(raw);
          const prevFinalPresence = redisUser.presence;

          if (newPresence === "away") {
            framesToSend = [];
            // Set each of the user's connections to away.
            // Remember each conn's pre-away idle/online state in `base`
            // so unaway can restore it instead of slamming every conn to
            // 'online'. The actual ws.send happens after release().
            Object.keys(redisUser.conns).forEach((k) => {
              const c = redisUser.conns[k];
              if (c.presence !== "away") c.base = c.presence;
              c.presence = "away";
              framesToSend.push([k, "away"]);
            });
          }
          else if (newPresence === "unaway") {
            framesToSend = [];
            // Restore each conn's remembered idle/online state. Fall back
            // to 'online' if `base` is missing (legacy entries written
            // before the base field existed).
            Object.keys(redisUser.conns).forEach((k) => {
              const c = redisUser.conns[k];
              const restore = (c.base === "idle" || c.base === "online") ? c.base : "online";
              c.presence = restore;
              c.base = restore;
              framesToSend.push([k, "unaway"]);
            });
          }
          else {
            // user.away decides whether to override transient presence; must
            // be read inside the lock to race-safely interleave with REST
            // /auth/settings/update-profile (which mutates user.away under
            // the same per-user lock). Moving this out requires denormalizing
            // user.away into the redis body — out of scope for this change.
            const user = await User.findOne({ where: { id } });
            const c = redisUser.conns[connId];
            if (c) {
              if (!user || !user.away) {
                // Not away: the conn's effective presence tracks activity.
                c.presence = newPresence;
                c.base = newPresence;
              } else {
                // Away: keep `presence:'away'` as the override, but update
                // `base` so a later unaway restores the conn to the current
                // idle/online state rather than the state at away-time.
                c.base = newPresence;
              }
            }
          }

          // Determine final display presence: away > online > idle
          let finalPresence = "idle";
          for (const cid of Object.keys(redisUser.conns)) {
            const p = redisUser.conns[cid].presence;
            if (p === "away") { finalPresence = "away"; break; }
            if (p === "online") finalPresence = "online";
          }
          redisUser.presence = finalPresence;

          await presenceClient.hSet(`users:${id}`, "body", JSON.stringify(redisUser));

          // Decide deferred effects while we still have prevFinalPresence.
          if (newPresence === "away" || newPresence === "unaway") {
            crossServerAwayFrame = true;
          }
          if (finalPresence !== prevFinalPresence) {
            presenceChangedTo = finalPresence;
          }

          await release();

          // ── Deferred side effects (outside the lock) ──
          if (framesToSend) {
            const conns = users.get(id);
            if (conns) {
              for (const [k, frame] of framesToSend) {
                if (conns[k]) {
                  try { conns[k].send(frame); } catch (e) { /* ignore */ }
                }
              }
            }
          }
          if (crossServerAwayFrame) {
            // Sync user's own other sessions (cross-server) for away/unaway.
            // presence frames go on `messages:global` so every WS worker
            // delivers to any local tabs of this user.
            publishClient.publish('messages:global', JSON.stringify({
              serverId,
              publishedAt: Date.now(),
              msg: { id, type: msg.type, value: msg.value }
            }));
          }
          if (presenceChangedTo !== null) {
            broadcastPresenceChange(id, presenceChangedTo);
          }
        }

        updateWSMetrics(date1);
      }
      catch (err) {
        console.log(err);
        try { await release() } catch (e) { console.log(e); }
        try { ws.send('error'); } catch (e) { /* ignore */ }
        ws.close();
        updateWSMetrics(date1);
      }
    });

    // ws.on('pong') removed — see PR #128

    ws.on('close', async () => {
      if (!id) return; // init failed, nothing to clean up

      let release = async () => {};
      try {
        // presenceChangedTo is captured inside the lock so the lock-protected
        // hSet/del completes before we incur the broadcastPresenceChange cost
        // (which queues a debounced fanout_all + cross-server publish).
        let presenceChangedTo = null;

        release = await lock(`lock:users:${id}`, lockOptions);
        const raw = await presenceClient.hGet(`users:${id}`, "body");
        if (!raw) {
          // Already cleaned up (e.g. by a concurrent close)
          connections.delete(connId);
          await release();
          return;
        }
        const redisUser = JSON.parse(raw);
        const connIds = Object.keys(redisUser.conns);

        connections.delete(connId);

        // "Last connection" is determined by whether this close removes the
        // only remaining conn — check against the conn set that actually
        // contains our connId to avoid racing with a concurrent init.
        if (connIds.length <= 1 && redisUser.conns[connId]) {
          await presenceClient.del(`users:${id}`);
          users.delete(id);
          presenceChangedTo = 'offline';
        }
        else {
          delete redisUser.conns[connId];
          const localConns = users.get(id);
          if (localConns) delete localConns[connId];

          // Recalculate presence with remaining connections: away > online > idle
          let finalPresence = "idle";
          for (const cid of Object.keys(redisUser.conns)) {
            const p = redisUser.conns[cid].presence;
            if (p === "away") { finalPresence = "away"; break; }
            if (p === "online") finalPresence = "online";
          }

          const prevFinalPresence = redisUser.presence;
          redisUser.presence = finalPresence;
          await presenceClient.hSet(`users:${id}`, "body", JSON.stringify(redisUser));

          if (finalPresence !== prevFinalPresence) {
            presenceChangedTo = finalPresence;
          }
        }

        await release();

        // Deferred broadcast — outside the lock.
        if (presenceChangedTo !== null) {
          broadcastPresenceChange(id, presenceChangedTo);
        }

        console.log(`${id} disconnected on connId ${connId} at ${(new Date()).toString()}`);
      }
      catch (err) {
        try { await release() } catch (e) { console.log(e); }
        console.log(err);
      }
    });


    // Initialization
    let didResetAway = false;
    let wasFirstConn = false;
    try {
      // Client GETS /auth/generate-ws-token, then attaches the token to this request
      const url = new URL(req.url, process.env.BASE_URL);
      const token = url.searchParams.get('token');
      id = jwt.verify(token, process.env.JWT_SECRET).id;

      const dbUser = await User.findByPk(id);

      // Per reviewer rule: reconnecting from offline clears `away`. Spec §2
      // says "disconnect/reconnect doesn't count as activity", which we read
      // as: a reconnect is a fresh session, not a continuation. We only
      // reset on a user's FIRST live connection (redis hash empty) — opening
      // a second tab while already connected leaves away alone, so users can
      // still set away and have it persist across tabs within a session.
      //
      // The reset happens BEFORE we create the new conn in Redis, and we
      // push an "unaway" frame on this socket before "ready" so the client's
      // auth state flips before HomeScreen's ready-handler reads
      // auth.user.away and sends the initial presence frame.

      let initRelease = async () => {};
      try {
        initRelease = await lock(`lock:users:${id}`, lockOptions);
        const existingStr = await presenceClient.hGet(`users:${id}`, "body");
        const isFirstConn = !existingStr;
        wasFirstConn = isFirstConn;

        if (isFirstConn && dbUser && dbUser.away) {
          dbUser.away = false;
          await dbUser.save();
          didResetAway = true;
        }

        // Every fresh conn starts as online with base=online. Multi-tab case
        // where the user is already away: existingStr is present, this block
        // still computes finalPresence from all existing conns (which will
        // still have presence='away'), so the new conn's 'online' is
        // overridden by the away priority and finalPresence stays 'away'.
        //
        // serverId records which worker process holds this WebSocket so pass-2
        // `broadcastToUsers` can route the cross-node fanout to the specific
        // worker(s) that have the recipient connected, instead of broadcasting
        // to every WS worker. Multi-tab on different workers naturally produces
        // distinct serverId entries across this user's `conns`.
        const newConn = { presence: "online", base: "online", serverId };

        let user;
        if (existingStr) {
          user = JSON.parse(existingStr);
          user.conns[connId] = newConn;
        }
        else {
          user = { presence: "online", conns: { [connId]: newConn } };
        }

        // Recompute final presence honoring away > online > idle across all conns
        let finalPresence = "idle";
        for (const cid of Object.keys(user.conns)) {
          const p = user.conns[cid].presence;
          if (p === "away") { finalPresence = "away"; break; }
          if (p === "online") finalPresence = "online";
        }
        user.presence = finalPresence;

        await presenceClient.hSet(`users:${id}`, "body", JSON.stringify(user));

        let conns = users.get(id);
        if (!conns) {
          conns = { [connId]: ws };
          users.set(id, conns);
        }
        else conns[connId] = ws;
        connections.set(connId, { userId: id, ws });

        // conns: SET removed — part of ping/pong, see PR #128

        await initRelease();
      }
      catch (err) {
        try { await initRelease() } catch (e) { console.log(e); }
      }

      // Order matters: push the "unaway" in-band frame BEFORE "ready" so the
      // client's ready-handler (HomeScreen.tsx) reads the corrected
      // auth.user.away when it decides which initial presence frame to send.
      // WS messages are delivered in order to the peer.
      if (didResetAway) {
        try { ws.send("unaway"); } catch (e) { /* ignore */ }
      }

      ws.send("ready");

      // On first connection (previously offline), tell every other connected
      // user that this user is now online. This fills a gap where observers
      // saw presence.changed:'offline' when the last conn closed but never
      // saw the offline → online transition on reconnect until the user's
      // first activity message. The previously-away-but-reset case also goes
      // through this branch. Self-excluded: this user's own tabs either
      // already know (multi-tab) or get the "unaway" frame above.
      if (wasFirstConn) {
        broadcastPresenceChange(id, 'online');
      }

      console.log(`${id} connected on connId ${connId} at ${(new Date()).toString()}`);
    }
    catch (err) {
      console.log(err);
      ws.close();
      return;
    }
  });
}

module.exports = {
  configureWSServer,
  broadcastToUsers,
  broadcastPresenceChange,
  notifyUserAwayFrame,
  getCoCommunityUserIds,
  initWSPublisher,
  initWSSubscriber,
  withUserPresenceLock,
  lockOptions
};