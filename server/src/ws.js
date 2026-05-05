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
    }
    else if (msg.type === "fanout") {
      let userIds = msg.userIds;
      if (userIds.length === 0 && msg.userIdsBuf) {
        userIds = bufferToUUIDs(Buffer.from(msg.userIdsBuf, 'base64'));
      }
      // Generic per-user fanout published from any worker. Deliver locally only.
      deliverLocal(userIds, msg.payload);
    }
    else if (msg.type === "fanout_all") {
      // Broadcast payload to every locally connected user (optionally excluding one).
      const data = typeof msg.payload === 'string' ? msg.payload : JSON.stringify(msg.payload);
      for (const [uid, conns] of users.entries()) {
        if (msg.excludeUserId && uid === msg.excludeUserId) continue;
        for (const cid of Object.keys(conns)) {
          try { conns[cid].send(data); } catch (e) { /* ignore broken socket */ }
        }
      }
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
  await subClient.subscribe('messages', handleSubMessage);
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
 *
 * Two log lines per interesting fanout:
 *
 *   evt: 'ws_fanout' — synchronous fanout-loop wall time (fast path)
 *     recipients: userIds passed in (full member list, before local filter)
 *     delivered:  count with at least one local conn
 *     frames:     total ws.send() calls (delivered users × their conn count)
 *     ms:         wall time for the synchronous loop
 *
 *   evt: 'ws_fanout_ack' — write-completion timing (the unmeasured WS-egress segment)
 *     recipients, delivered, frames as above
 *     acks:        number of send() callbacks that fired
 *     max_ack_ms:  slowest ack across all frames in this fanout (= worst-client tail)
 *     avg_ack_ms:  mean ack time across this fanout's frames
 *     fanout_ms:   wall time from t0 to last ack
 *
 * `ws.send(data, cb)` invokes cb after the frame has been encoded and the
 * underlying socket.write() has flushed (kernel send buffer accepted) — NOT
 * receiver ACK. Slow clients with full kernel send buffers show up here.
 *
 * Logged only when (a) recipients >= 50 or (b) max ack >= 50ms, to keep
 * log volume bounded. ackState lives in a closure per fanout — one heap
 * alloc per broadcast, GC'd once last ack fires.
 */
function deliverLocal(userIds, payload) {
  const t0 = Date.now();
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  let delivered = 0, frames = 0;
  const ackState = { expected: 0, received: 0, sumMs: 0, maxMs: 0 };
  for (const userId of userIds) {
    const conns = users.get(userId);
    if (!conns) continue;
    delivered++;
    for (const cid of Object.keys(conns)) {
      const tSend = Date.now();
      try {
        ackState.expected++;
        conns[cid].send(data, () => {
          const ms = Date.now() - tSend;
          ackState.received++;
          ackState.sumMs += ms;
          if (ms > ackState.maxMs) ackState.maxMs = ms;
          if (ackState.received === ackState.expected && (userIds.length >= 50 || ackState.maxMs >= 50)) {
            console.log(JSON.stringify({
              evt: 'ws_fanout_ack',
              recipients: userIds.length,
              delivered, frames: ackState.expected,
              acks: ackState.received,
              max_ack_ms: ackState.maxMs,
              avg_ack_ms: Math.round(ackState.sumMs / ackState.received),
              fanout_ms: Date.now() - t0,
            }));
          }
        });
        frames++;
      } catch (e) {
        ackState.expected--; // rollback so the ackState.received === ackState.expected guard remains valid
        /* ignore broken socket */
      }
    }
  }
  const ms = Date.now() - t0;
  if (userIds.length >= 50 || ms >= 5) {
    console.log(JSON.stringify({
      evt: 'ws_fanout',
      recipients: userIds.length,
      delivered, frames, ms,
    }));
  }
}


let broadcastMetrics = { numMessages: 0, sumProcessing: 0 };
function logBroadcastMetrics() {
  let avg = 0;
  if (broadcastMetrics.numMessages > 0) avg = broadcastMetrics.sumProcessing / broadcastMetrics.numMessages;
  console.log(`Message Broadcast Metrics: ${broadcastMetrics.numMessages} broadcasts, ${avg} ms average time to broadcast`);
}
setInterval(logBroadcastMetrics, 30000);

/**
 * Fan out a JSON payload to all sessions of the given user ids, across every
 * server in the cluster. Use this from REST handlers when a write needs to
 * push a real-time update (message.created, conversation.participants_changed, ...).
 */
function broadcastToUsers(userIds, payload) {
  if (!userIds || userIds.length === 0) return;
  let date1 = Date.now();

  deliverLocal(userIds, payload);

  const buf = Buffer.concat(
    userIds.map(u => Buffer.from(u.replace(/-/g, ''), 'hex'))
  );

  publishClient.publish('messages', JSON.stringify({
    serverId,
    msg: { type: 'fanout', userIds: [], userIdsBuf: buf.toString('base64'), payload },
  }));

  let date2 = Date.now();
  broadcastMetrics.numMessages++;
  broadcastMetrics.sumProcessing += date2 - date1;
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
  // Local delivery
  const conns = users.get(userId);
  if (conns) {
    for (const cid of Object.keys(conns)) {
      try { conns[cid].send(value); } catch (e) { /* ignore broken socket */ }
    }
  }
  // Cross-server fanout
  publishClient.publish('messages', JSON.stringify({
    serverId,
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
  // Local delivery
  for (const [uid, conns] of users.entries()) {
    if (uid === excludeUserId) continue;
    for (const cid of Object.keys(conns)) {
      try { conns[cid].send(data); } catch (e) { /* ignore broken socket */ }
    }
  }
  // Cross-server fanout
  publishClient.publish('messages', JSON.stringify({
    serverId,
    msg: { type: 'fanout_all', payload, excludeUserId: excludeUserId || null },
  }));
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
 * Broadcast a presence.changed event to users who share a community or
 * conversation with the subject. Previously this called broadcastToAllConnected
 * (despite the comment claiming otherwise) which sent presence to every
 * connected user cluster-wide — at our scale that was ~90K WS frames/sec
 * just for presence vs ~50/sec for actual messages, monopolizing the WS
 * event loop and inflating delivery p95.
 */
async function broadcastPresenceChange(userId, presence) {
  const audienceIds = await getPresenceAudienceUserIds(userId);
  if (audienceIds.length === 0) return;
  broadcastToUsers(audienceIds, {
    type: 'presence.changed',
    userId,
    presence,
  });
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

          release = await lock(`lock:users:${id}`, lockOptions, 'ws_presence_msg');
          const conns = users.get(id);
          const raw = await presenceClient.hGet(`users:${id}`, "body");
          if (!raw) {
            await release();
            updateWSMetrics(date1);
            return; // connection closed between reads
          }
          const redisUser = JSON.parse(raw);
          const prevFinalPresence = redisUser.presence;

          if (newPresence === "away") {
            // Set each of the user's connections to away and notify them.
            // Remember each conn's pre-away idle/online state in `base`
            // so unaway can restore it instead of slamming every conn to
            // 'online'.
            Object.keys(redisUser.conns).forEach((k) => {
              const c = redisUser.conns[k];
              if (c.presence !== "away") c.base = c.presence;
              c.presence = "away";
              if (conns && conns[k]) {
                try { conns[k].send("away"); } catch (e) { /* ignore */ }
              }
            });
          }
          else if (newPresence === "unaway") {
            // Restore each conn's remembered idle/online state. Fall back
            // to 'online' if `base` is missing (legacy entries written
            // before the base field existed).
            Object.keys(redisUser.conns).forEach((k) => {
              const c = redisUser.conns[k];
              const restore = (c.base === "idle" || c.base === "online") ? c.base : "online";
              c.presence = restore;
              c.base = restore;
              if (conns && conns[k]) {
                try { conns[k].send("unaway"); } catch (e) { /* ignore */ }
              }
            });
          }
          else {
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

          // Sync user's own other sessions (cross-server) for away/unaway
          if (newPresence === "away" || newPresence === "unaway") {
            publishClient.publish("messages", JSON.stringify({
              serverId,
              msg: { id, type: msg.type, value: msg.value }
            }));
          }

          // Broadcast to relevant users whenever final presence actually changed
          if (finalPresence !== prevFinalPresence) {
            broadcastPresenceChange(id, finalPresence);
          }

          await release();
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
        release = await lock(`lock:users:${id}`, lockOptions, 'ws_close');
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
          broadcastPresenceChange(id, 'offline');
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
            broadcastPresenceChange(id, finalPresence);
          }
        }

        await release();
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
        initRelease = await lock(`lock:users:${id}`, lockOptions, 'ws_init');
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
        const newConn = { presence: "online", base: "online" };

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