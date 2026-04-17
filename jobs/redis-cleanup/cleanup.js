require('dotenv').config({path: __dirname + "/.env"});

const { createClient } = require('redis');
const redisClient = createClient({ url: process.env.REDIS_URL });
redisClient.on('error', err => console.log('Redis Client Error', err));
redisClient.connect();
redisClient.on('ready', async () => {
  console.log("Redis connected");
  await cleanConnections();
  await redisClient.close();
});

const { lock } = require('simple-redis-mutex');
const lockOptions = { timeout: 200, pollingInterval: 5 };


async function cleanConnections() {
  let time1 = Date.now();
  console.log('Cleaning connections...');

  const results = [];

  let cursor = '0';
  do {
    const reply = await redisClient.scan(cursor, {
      MATCH: 'users:*',
      COUNT: 100
    });

    cursor = reply.cursor;
    results.push(...reply.keys);
  } while (cursor !== '0');

  let time2 = Date.now();

  const allusers = results.flat();
  console.log(`Got ${allusers.length} users in ${time2-time1}ms`);
  for (let i = 0; i < allusers.length; i++) {
    if (i % 100 === 0) console.log(i);
    let release = async () => {};
    try {
      release = await lock(redisClient, `lock:${allusers[i]}`, lockOptions);
      const raw = await redisClient.hGet(allusers[i], "body");
      if (!raw) {
        await release();
        continue;
      }

      const redisUser = JSON.parse(raw);
      const connIds = Object.keys(redisUser.conns);

      for (let j = 0; j < connIds.length; j++) {
        let connId = connIds[j];
        let conn = await redisClient.get(`conns:${connId}`);
        if (!conn) {
          delete redisUser.conns[connId];
        }
      }

      if (Object.keys(redisUser.conns).length === 0) {
        await redisClient.del(allusers[i]);
      }
      else {
        await redisClient.hSet(allusers[i], "body", JSON.stringify(redisUser));
      }

      await release();
    }
    catch (err) {
      console.log(err);
      try { await release() } catch (e) { console.log(e); }
    }
  }
  let time3 = Date.now();
  console.log(`Cleaned connections in ${time3-time1}ms total`);
}