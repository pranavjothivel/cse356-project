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



const jwt = require('jsonwebtoken');

/**
 * users: id -> ws
 */
const users = new Map();

const configureWSServer = (wss) => {
  wss.on('connection', async (ws, req) => {
    let id;
    try {
      const url = new URL(req.url, process.env.BASE_URL);
      const token = url.searchParams.get('token');
      
      id = jwt.verify(token, process.env.JWT_SECRET).id;
      await redisClient.json.set("users", `$.${id}`, {presence: "online"});
      users.set(id, ws);
      console.log('Client connected');
    } catch (err) {
      console.log(err);
      ws.close();
      return;
    }

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data);
        
        if (msg.type === 'presence') {
          let newPresence = msg.value;
          if (newPresence === "online" || newPresence === "idle" || newPresence === "away") {
            let presence = await redisClient.json.get("users", {path: `$.${id}`});
            await redisClient.json.set("users", `$.${id}`, {presence: newPresence});
          }
        }

        ws.send('Received');
      }
      catch (err) {
        console.log(err);
        ws.send('error');
        ws.close();
      }
    });

    ws.on('close', async () => {
      try {
        await redisClient.json.del("users", { path: `$.${id}` });
        users.delete(id);
        console.log('Client disconnected');
      }
      catch (err) {
        console.log(err);
      }
    });
  });
}

module.exports = { configureWSServer }