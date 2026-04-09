const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const { Op } = require('sequelize');
const User = require('./models/User');
const CommunityMember = require('./models/CommunityMember');
const redisClient = require('./redis');

// Identifier that should be sent when publishing through Redis
const serverId = crypto.randomUUID();

// subClient is dedicated to receiving updates published by other instances
const subClient = redisClient.duplicate();
subClient.connect();
subClient.on('ready', () => {
  console.log("Redis subscriber connected");
});
subClient.subscribe('messages', (msg) => {
  try {
    msg = JSON.parse(msg);
    // Ignore messages you published
    if (msg.serverId === serverId) return;

    msg = msg.msg;

    if (msg.type === "presence") {
      let conns = users.get(msg.id);
      if (!conns) return; // Nothing to do if no connections

      if (msg.value === "away") {
        Object.keys(conns).forEach((k) => {
          conns[k].send("away");
        });
      }
      else if (msg.value === "unaway") {
        Object.keys(conns).forEach((k) => {
          conns[k].send("unaway");
        });
      }
    }
    else if (msg.type === "fanout") {
      // Generic per-user fanout published from any worker. Deliver locally only.
      deliverLocal(msg.userIds, msg.payload);
    }

  }
  catch (err) {
    console.log(err);
  }
});



/*
  Current structure in redis:

  HGET users:[id] body
  HGET users:[id] body [string representation of body]
  body:
    {
      presence - final presence used for display - "online" if any connection online, "away" if any away, "idle" if all idle
      conns: {
        [connId]: { presence: "online" or "idle" or "away" }
        [another connId]: { presence }
        ...
      }
    }
  Race condition is possible, but given that it requires the same user to spam presence updates across multiple connections, it can likely be ignored


  Ideas (the following are not currently used in code, so feel free to remove these if you think of something better):

  SADD/SREM [community id] [connection id of client currently on this community]
  SMEMBERS community_id

  SADD/SREM [channel_id] [connection id of client currently on this channel]
  SMEMBERS channel_id
*/



/**
 * Maps user id to an object of ws connections for that user
 * 
 * users: id -> { connId1: ws1, connId2: ws2, ... }
 * 
 * Probably not useful outside of syncing the away state
 */
const users = new Map();

/**
 * Maps connection id to an object containing the ws connection and other data
 * 
 * connections: connId -> { ws }
 * 
 * Might be useful to add communityId, channelId, etc. to object
 */
const connections = new Map();

/*
  Ideas (again, feel free to remove these comments if you think of something better):

  communities: community_id -> { connId1: ws1, connId2: ws2, ... }
  channels: channels_id -> { connId1: ws1, connId2: ws2, ... }
*/


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
 * Fan out a JSON payload to all sessions of the given user ids, across every
 * server in the cluster. Use this from REST handlers when a write needs to
 * push a real-time update (message.created, conversation.participants_changed, ...).
 */
function broadcastToUsers(userIds, payload) {
  if (!userIds || userIds.length === 0) return;
  deliverLocal(userIds, payload);
  redisClient.publish('messages', JSON.stringify({
    serverId,
    msg: { type: 'fanout', userIds, payload },
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

const configureWSServer = (wss) => {
  wss.on('connection', async (ws, req) => {
    let connId = crypto.randomUUID();
    let id;

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data);
   
        if (msg.type === 'presence') {
          let newPresence = msg.value;

          if (!(newPresence === "online" || newPresence === "idle" || newPresence === "away" || newPresence === "unaway")) return;

          let conns = users.get(id);
          let redisUser = JSON.parse(await redisClient.hGet(`users:${id}`, "body"));
          const prevFinalPresence = redisUser.presence;

          if (newPresence === "away") {
            // Set each of the user's connections to away and notify them
            Object.keys(redisUser.conns).forEach((k) => {
              if (conns[k]) conns[k].send("away");
              redisUser.conns[k].presence = "away";
            });
          }
          else if (newPresence === "unaway") {
            // Set each of the user's connections to online and notify them
            Object.keys(redisUser.conns).forEach((k) => {
              if (conns[k]) conns[k].send("unaway");
              redisUser.conns[k].presence = "online";
            });
          }
          else {
            const user = await User.findOne({ where: { id } });
            // Don't override away if user has it set
            if (!user || !user.away) {
              redisUser.conns[connId].presence = newPresence;
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

          // Broadcast to co-community users whenever final presence actually changed
          if (finalPresence !== prevFinalPresence) {
            const coCommunityUserIds = await getCoCommunityUserIds(id);
            broadcastToUsers(coCommunityUserIds, {
              type: 'presence.changed',
              userId: id,
              presence: finalPresence,
            });
          }
        }

      }
      catch (err) {
        console.log(err);
        ws.send('error');
        ws.close();
      }
    });

    ws.on('close', async () => {
      try {
        let redisUser = JSON.parse(await redisClient.hGet(`users:${id}`, "body"));
        const arr = Object.keys(redisUser.conns);

        connections.delete(connId);

        if (arr.length === 1) {
          // Last connection — user is now offline
          await redisClient.del(`users:${id}`);
          users.delete(id);
          // Broadcast offline to co-community users
          const coCommunityUserIds = await getCoCommunityUserIds(id);
          broadcastToUsers(coCommunityUserIds, {
            type: 'presence.changed',
            userId: id,
            presence: 'offline',
          });
        }
        else {
          delete redisUser.conns[connId];
          delete users.get(id)[connId];

          // Recalculate presence with remaining connections: away > online > idle
          let finalPresence = "idle";
          for (const cid of Object.keys(redisUser.conns)) {
            const p = redisUser.conns[cid].presence;
            if (p === "away") { finalPresence = "away"; break; }
            if (p === "online") finalPresence = "online";
          }

          // Broadcast if presence changed (e.g. the closing tab was the only online one)
          if (finalPresence !== redisUser.presence) {
            redisUser.presence = finalPresence;
            const coCommunityUserIds = await getCoCommunityUserIds(id);
            broadcastToUsers(coCommunityUserIds, {
              type: 'presence.changed',
              userId: id,
              presence: finalPresence,
            });
          }

          redisUser.presence = finalPresence;
          await redisClient.hSet(`users:${id}`, "body", JSON.stringify(redisUser));
        }

        console.log('Client disconnected');
      }
      catch (err) {
        console.log(err);
      }
    });


    // Initialization
    try {
      // Client GETS /auth/generate-ws-token, then attaches the token to this request
      const url = new URL(req.url, process.env.BASE_URL);
      const token = url.searchParams.get('token');
      id = jwt.verify(token, process.env.JWT_SECRET).id;

      let userStr = await redisClient.hGet(`users:${id}`, "body");

      let user;
      if (userStr) {
        user = JSON.parse(userStr);
        user.conns[connId] = {presence: "online"};
      }
      else {
        user = {presence: "online", conns: { [connId]: {presence: "online"} }};
      }
      await redisClient.hSet(`users:${id}`, "body", JSON.stringify(user));

      let conns = users.get(id);
      if (!conns) {
        conns = {[connId]: ws};
        users.set(id, conns);
      }
      else conns[connId] = ws;
      connections.set(connId, { ws });

      connReady = true;
      ws.send("ready");
      console.log('Client connected');
    }
    catch (err) {
      console.log(err);
      ws.close();
      return;
    }
  });
}

module.exports = { configureWSServer, broadcastToUsers, getCoCommunityUserIds };