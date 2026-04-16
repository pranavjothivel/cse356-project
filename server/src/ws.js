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
const { lock } = require('simple-redis-mutex');
const lockOptions = { timeout: 200, pollingInterval: 5 };

const { Op } = require('sequelize');
const User = require('./models/User');
const CommunityMember = require('./models/CommunityMember');
const ConversationParticipant = require('./models/ConversationParticipant');
const redisClient = require('./redis');

// Identifier that should be sent when publishing through Redis
const serverId = crypto.randomUUID();

// subClient is dedicated to receiving updates published by other instances.
// Connection + subscription are awaited in initWS() before the HTTP server
// starts accepting requests, so presence fanout cannot be silently missed
// during the startup window.
const subClient = redisClient.duplicate();
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
      // Generic per-user fanout published from any worker. Deliver locally only.
      deliverLocal(msg.userIds, msg.payload);
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

/**
 * Initialize the Redis subscriber. Must be awaited from app startup before
 * the HTTP server begins accepting requests — otherwise fanout_all messages
 * published by other workers during the startup window would be dropped.
 */
async function initWS() {
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
  SET conns:[connId] 1 EX 60
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


/**
 * Pings all local connections whose ids start with firstCharInId
 * 
 * Used to spread pings equally over the interval to reduce any potential load from pong writes
 */
function pingLocalConnections(firstCharInId) {
  let time1 = Date.now();
  let connectionsArray = [...connections];
  for (let i = 0; i < connectionsArray.length; i++) {
    if (connectionsArray[i][0][0] !== firstCharInId) continue;
    
    let ws;
    try { ws = connectionsArray[i][1].ws; } catch (e) {}
    if (!ws) continue;

    try {
      ws.ping();
    }
    catch (e) {ws.close();}
  }

  let time2 = Date.now();
  console.log(`Pinged local connections starting with ${firstCharInId} in ${time2-time1}ms`);
}
let idChars = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'];
for (let i = 0; i <= 15; i++)
  setTimeout(() => {setInterval(pingLocalConnections, 60000, idChars[i])}, 3750*i);


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
  redisClient.publish('messages', JSON.stringify({
    serverId,
    msg: { type: 'fanout', userIds, payload },
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
  redisClient.publish('messages', JSON.stringify({
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
  redisClient.publish('messages', JSON.stringify({
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
 * Get all user IDs who should see this user's presence changes:
 * co-community members + conversation (DM/group) partners.
 */
async function getPresenceAudienceUserIds(userId) {
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

  return [...new Set([...communityUserIds, ...convUserIds])];
}

/**
 * Broadcast a presence.changed event to all users who share a community or
 * conversation with the subject user. Replaces the old broadcastToAllConnected
 * approach which sent presence to every connected user in the cluster.
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

          release = await lock(redisClient, `lock:users:${id}`, lockOptions);
          const conns = users.get(id);
          const raw = await redisClient.hGet(`users:${id}`, "body");
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

          await redisClient.hSet(`users:${id}`, "body", JSON.stringify(redisUser));

          // Sync user's own other sessions (cross-server) for away/unaway
          if (newPresence === "away" || newPresence === "unaway") {
            redisClient.publish("messages", JSON.stringify({
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

    ws.on('pong', async () => {
      try {
        await redisClient.set(`conns:${connId}`, 1, { EX: 60 });
      }
      catch (err) {
        console.log(err);
        ws.close();
      }
    });

    ws.on('close', async () => {
      if (!id) return; // init failed, nothing to clean up

      let release = async () => {};
      try {
        release = await lock(redisClient, `lock:users:${id}`, lockOptions);
        const raw = await redisClient.hGet(`users:${id}`, "body");
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
          await redisClient.del(`users:${id}`);
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
          await redisClient.hSet(`users:${id}`, "body", JSON.stringify(redisUser));

          if (finalPresence !== prevFinalPresence) {
            broadcastPresenceChange(id, finalPresence);
          }
        }

        console.log(`${id} disconnected on connId ${connId}`);
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
        initRelease = await lock(redisClient, `lock:users:${id}`, lockOptions);
        const existingStr = await redisClient.hGet(`users:${id}`, "body");
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

        await redisClient.hSet(`users:${id}`, "body", JSON.stringify(user));

        let conns = users.get(id);
        if (!conns) {
          conns = { [connId]: ws };
          users.set(id, conns);
        }
        else conns[connId] = ws;
        connections.set(connId, { userId: id, ws });

        await redisClient.set(`conns:${connId}`, 1, { EX: 120 });

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

      console.log(`${id} connected on connId ${connId}`);
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
  initWS,
  withUserPresenceLock,
  lockOptions
};