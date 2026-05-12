#!/usr/bin/env node
//
// End-to-end delivery latency test.
//
// Two real clients (HTTP sender, WS receiver) register fresh accounts, share a
// public channel, and the sender posts N messages tagged with a per-message
// nonce. We measure wall time from "before request().send()" on the sender
// to "WS frame arrives" on the receiver, matching by nonce in message content.
//
// Compare against:
//   - server-internal p99 (≈260ms) from PM2 timing logs
//   - autograder-reported delivery p95 (≈1500ms) from the chart
//
// If this script (run from a server node, private LAN to LB) reports ~150-250ms
// p95, the gap lives in the autograder's probe topology / measurement.
// If it reports ~1000ms+, there's something on the LB/network path we missed.
//
// Usage (from a node, where node_modules has `ws` installed already):
//   cd /srv/app && node /path/to/e2e-delivery-latency.js [N=100] [delayMs=100]
//
// Or local: npm i ws  ; then node scripts/e2e-delivery-latency.js
//
// Env overrides:
//   HOST=group1.cse356.compas.cs.stonybrook.edu  (default; pin to LB IP via
//     /etc/hosts or HOST_IP env to skip DNS)
//   FORCE_COLD=1     open a fresh https Agent for each POST (no keep-alive),
//                    simulating an autograder that doesn't reuse connections.

const https = require('https');
const { performance } = require('perf_hooks');
const WebSocket = require('ws');

const HOST   = process.env.HOST || 'group1.cse356.compas.cs.stonybrook.edu';
const N      = parseInt(process.argv[2], 10) || 100;
const DELAY  = parseInt(process.argv[3], 10) || 100;
const COLD   = process.env.FORCE_COLD === '1';

const BASE   = `https://${HOST}`;
const WSBASE = `wss://${HOST}`;

// Single keep-alive agent unless COLD mode is on.
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 8 });

function makeJar() {
  const cookies = {};
  return {
    get header() { return Object.entries(cookies).map(([k,v]) => `${k}=${v}`).join('; '); },
    update(setCookie) {
      if (!setCookie) return;
      const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
      for (const sc of arr) {
        const [pair] = sc.split(';');
        const [k, v] = pair.split('=');
        if (k && v !== undefined) cookies[k.trim()] = v.trim();
      }
    },
  };
}

function request(method, path, body, jar) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const agent = COLD ? new https.Agent({ keepAlive: false }) : keepAliveAgent;
    const req = https.request({
      hostname: HOST,
      port: 443,
      path,
      method,
      agent,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(jar?.header ? { 'Cookie': jar.header } : {}),
      },
    }, res => {
      jar?.update(res.headers['set-cookie']);
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let parsed;
        try { parsed = JSON.parse(text); } catch { parsed = text; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function register(username, password, email) {
  const jar = makeJar();
  const r = await request('POST', '/api/auth/register', { username, password, email }, jar);
  if (r.status >= 400) throw new Error(`register ${username}: ${r.status} ${JSON.stringify(r.body)}`);
  return jar;
}

async function getWsToken(jar) {
  const r = await request('GET', '/api/auth/generate-ws-token', null, jar);
  if (r.status >= 400) throw new Error(`ws-token: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.token;
}

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(Math.floor(s.length * p), s.length - 1)];
}

async function main() {
  console.log(`HOST=${HOST}  N=${N}  delay=${DELAY}ms  cold=${COLD}`);
  const ts = Date.now();
  const userA = `e2e_a_${ts}`;
  const userB = `e2e_b_${ts}`;
  const password = 'TestPass123!aa';

  console.log('Registering users…');
  const jarA = await register(userA, password, `${userA}@e2e.local`);
  const jarB = await register(userB, password, `${userB}@e2e.local`);

  console.log('Creating community + channel as A…');
  const com = await request('POST', '/api/communities', { name: `e2e-${ts}` }, jarA);
  if (com.status >= 400) throw new Error(`community: ${JSON.stringify(com.body)}`);
  const communityId = com.body.community.id;

  const ch = await request('POST', `/api/communities/${communityId}/channels`, { name: 'general', is_private: false }, jarA);
  if (ch.status >= 400) throw new Error(`channel: ${JSON.stringify(ch.body)}`);
  const channelId = ch.body.channel.id;
  console.log(`community=${communityId}  channel=${channelId}`);

  console.log('B joining community…');
  const join = await request('POST', `/api/communities/${communityId}/join`, {}, jarB);
  if (join.status >= 400) throw new Error(`join: ${JSON.stringify(join.body)}`);

  console.log('Getting WS tokens…');
  const tokenA = await getWsToken(jarA);
  const tokenB = await getWsToken(jarB);

  console.log('Opening WS for both clients…');
  const wsA = new WebSocket(`${WSBASE}/ws?token=${tokenA}`);
  const wsB = new WebSocket(`${WSBASE}/ws?token=${tokenB}`);
  await Promise.all([
    new Promise((res, rej) => { wsA.once('open', res); wsA.once('error', rej); }),
    new Promise((res, rej) => { wsB.once('open', res); wsB.once('error', rej); }),
  ]);

  // Wait for ws "ready" frame from both
  await Promise.all([
    new Promise(res => { const f = m => { if (m.toString() === 'ready') { wsA.off('message', f); res(); } }; wsA.on('message', f); }),
    new Promise(res => { const f = m => { if (m.toString() === 'ready') { wsB.off('message', f); res(); } }; wsB.on('message', f); }),
  ]);
  console.log('Both clients ready. Running test…');

  const pending = new Map();   // nonce -> sendT0 (performance.now ms)
  const latencies = [];
  let timeouts = 0;

  wsB.on('message', raw => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === 'channel.message.created' && m.message?.content) {
      const t1 = performance.now();
      const t0 = pending.get(m.message.content);
      if (t0 !== undefined) {
        latencies.push(t1 - t0);
        pending.delete(m.message.content);
      }
    }
  });

  // Warmup: discard first 5
  const WARMUP = 5;
  for (let i = 0; i < N + WARMUP; i++) {
    const nonce = `e2e-${ts}-${i}`;
    pending.set(nonce, performance.now());
    // Fire-and-forget so subsequent sends aren't gated on response
    request('POST', '/api/messages', { channelId, content: nonce }, jarA)
      .catch(err => console.error('send err', err.message));
    await new Promise(r => setTimeout(r, DELAY));
  }

  console.log('Waiting 5s for tail messages…');
  await new Promise(r => setTimeout(r, 5000));

  for (const [nonce] of pending) timeouts++;
  // Drop warmup samples (first WARMUP latencies in arrival order ~ first WARMUP sends)
  const useful = latencies.slice(WARMUP);

  console.log('');
  console.log(`=== End-to-end delivery latency (HTTP POST → WS receive) ===`);
  console.log(`sent=${N + WARMUP}  received=${latencies.length}  warmup_dropped=${WARMUP}  timeouts=${timeouts}  N=${useful.length}`);
  if (useful.length === 0) {
    console.log('No samples — aborting.');
    process.exit(1);
  }
  console.log(`p50 : ${pct(useful, 0.5).toFixed(1)} ms`);
  console.log(`p90 : ${pct(useful, 0.9).toFixed(1)} ms`);
  console.log(`p95 : ${pct(useful, 0.95).toFixed(1)} ms`);
  console.log(`p99 : ${pct(useful, 0.99).toFixed(1)} ms`);
  console.log(`max : ${Math.max(...useful).toFixed(1)} ms`);
  console.log(`mean: ${(useful.reduce((a,b)=>a+b,0)/useful.length).toFixed(1)} ms`);

  wsA.close();
  wsB.close();
}

main().catch(err => { console.error(err); process.exit(1); });
