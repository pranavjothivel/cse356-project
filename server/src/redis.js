// Redis config, used by ws and app (for session store)
const { createClient } = require('redis');
const redisClient = createClient({ url: process.env.REDIS_URL });
redisClient.on('error', err => console.log('Redis Client Error', err));
redisClient.connect();
redisClient.on('ready', () => {
  console.log("Redis main connected");
});

module.exports = redisClient;