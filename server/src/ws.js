const User = require('./models/User');


// Redis config
const { createClient } = require('redis');
const redisClient = createClient({ url: process.env.REDIS_URL });
redisClient.on('error', err => console.log('Redis Client Error', err));
redisClient.connect();
redisClient.on('ready', () => {
  console.log("Redis connected");

  // _placeholder needed to prevent auto-deletion of empty objects
  redisClient.json.set("users", "$", {"_placeholder": 1}); 
});

/*
  Current Redis structure:
  users: {
    _placholder: 1
    clientid1: {
      presence - final presence used for display - "online" if any connection online, "away" if any away, "idle" if all idle
      conns: {
        connId1: { presence: "online" or "idle" or "away" }
        connId2: { presence }
        ...
      }
    }
    clientid2: {...}
    ...
  }
*/


const jwt = require('jsonwebtoken');

/**
 * Maps user id to an object of ws connections
 * 
 * users: id -> { connId1: ws1, connId2: ws2, ... }
 */
const users = new Map();

var counter = 0; // Determines connId

const configureWSServer = (wss) => {
  wss.on('connection', async (ws, req) => {
    let connId = counter++;
    let id;

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data);
   
        if (msg.type === 'presence') {
          let newPresence = msg.value;
          
          if (newPresence === "online" || newPresence === "idle" || newPresence === "away" || newPresence === "unaway") {
            let conns = users.get(id);
            let redisConns = (await redisClient.json.get("users", { path: `$.${id}.conns`}))[0];

            if (newPresence == "away") {
              // Set each of the user's connections to away and notify them
              Object.keys(redisConns).forEach((k) => {
                if (conns[k]) conns[k].send("away");
                redisConns[k].presence = "away";
              });
              await redisClient.json.set("users", `$.${id}.conns`, redisConns);
            }
            else if (newPresence === "unaway") {
              // Set each of the user's connections to online and notify them
              Object.keys(redisConns).forEach((k) => {
                if (conns[k]) conns[k].send("unaway");
                redisConns[k].presence = "online";
              });
              await redisClient.json.set("users", `$.${id}.conns`, redisConns);
            }
            else {
              const user = User.findOne({ where: {id} });
              // Make sure to not override away
              if (!user.away) {
                redisConns[connId].presence = newPresence;
                await redisClient.json.set("users", `$.${id}.conns.${connId}.presence`, newPresence);
              }
            }

            // Determine display presence
            let finalPresence = "idle";
            let arr = Object.keys(redisConns);
            for (let i = 0; i < arr.length; i++) {
              // If any connection has "online" or "away", use its presence
              if (redisConns[arr[i]].presence !== "idle") {
                finalPresence = redisConns[arr[i]].presence;
                break;
              }
            }
            await redisClient.json.set("users", `$.${id}.presence`, finalPresence);
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
        let redisConns = (await redisClient.json.get("users", { path: `$.${id}.conns`}))[0];
        // Determine display presence
        let finalPresence = "idle";
        let arr = Object.keys(redisConns);
        for (let i = 0; i < arr.length; i++) {
          if (arr[i] == connId) continue;
          console.log(redisConns[arr[i]].presence);
          if (redisConns[arr[i]].presence !== "idle") {
            finalPresence = redisConns[arr[i]].presence;
            break;
          }
        }
        await redisClient.json.set("users", `$.${id}.presence`, finalPresence);

        if (arr.length === 1) {
          // Delete user completely if no more connections
          await redisClient.json.del("users", { path: `$.${id}` });
          users.delete(id);
        }
        else {
          await redisClient.json.del("users", { path: `$.${id}.conns.${connId}` });
          delete users.get(id)[connId];
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

      await redisClient.json.set("users", `$.${id}`, {presence: "online", conns: {}}, { condition: "NX" });
      await redisClient.json.set("users", `$.${id}.conns.${connId}`, {presence: "online"});

      let conns = users.get(id);
      if (!conns) {
        conns = {[connId]: ws};
        users.set(id, conns);
      }
      else conns[connId] = ws;

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

module.exports = { configureWSServer }