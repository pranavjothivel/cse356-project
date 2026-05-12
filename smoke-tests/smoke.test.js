/**
 * Post-deploy smoke tests. Run via `npm test` from this directory.
 *
 * Override the deployment under test with TARGET:
 *   TARGET=http://localhost:3000 npm test
 *
 * Each check is independent; one failure does not short-circuit the others.
 */

const WebSocket = require('ws');

const TARGET = (process.env.TARGET || 'https://group1.cse356.compas.cs.stonybrook.edu').replace(/\/$/, '');
const WS_PATH = process.env.WS_PATH || '/api?token=__smoke__';

const fetchOpts = (extra = {}) => ({ redirect: 'manual', ...extra });

describe(`Smoke checks against ${TARGET}`, () => {
  test('SPA bundle reachable — GET / returns 200', async () => {
    const res = await fetch(`${TARGET}/`, fetchOpts());
    expect(res.status).toBe(200);
  });

  test('API auth-required path returns 401 unauthenticated — GET /api/auth/me', async () => {
    const res = await fetch(`${TARGET}/api/auth/me`, fetchOpts());
    expect(res.status).toBe(401);
  });

  test('API pool routing alive — GET /api/communities returns 401 unauthenticated', async () => {
    const res = await fetch(`${TARGET}/api/communities`, fetchOpts());
    expect(res.status).toBe(401);
  });

  test('Google OAuth redirect — GET /api/auth/google returns 302', async () => {
    const res = await fetch(`${TARGET}/api/auth/google`, fetchOpts());
    expect(res.status).toBe(302);
    const loc = res.headers.get('location') || '';
    expect(loc).toMatch(/accounts\.google\.com/);
  });

  test('WebSocket upgrade routes to WS pool — handshake completes', async () => {
    const wsUrl = TARGET.replace(/^http/, 'ws') + WS_PATH;
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { rejectUnauthorized: false });
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('WS handshake timeout after 5s'));
      }, 5000);
      ws.once('open', () => {
        clearTimeout(timer);
        ws.close();
        resolve();
      });
      ws.once('error', err => {
        clearTimeout(timer);
        reject(err);
      });
    });
  });
});
