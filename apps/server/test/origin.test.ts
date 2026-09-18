import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { AddressInfo } from 'node:net';
import { buildServer, type BuiltServer } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { JWT_SECRET } from './helpers.js';

/** WebSocket Origin policy (cross-site WebSocket hijacking protection). */
describe('websocket origin check', () => {
  let s: BuiltServer;
  let port: number;
  beforeAll(async () => {
    const config = { ...loadConfig({ NODE_ENV: 'test', JWT_SECRET, DATABASE_URL: 'pglite://memory' }), corsOrigins: ['https://school.example'] };
    s = await buildServer(config);
    await s.app.listen({ port: 0, host: '127.0.0.1' });
    port = (s.app.server.address() as AddressInfo).port;
  });
  afterAll(() => s.close());

  const tryOpen = (origin?: string) =>
    new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, origin ? { origin } : {});
      ws.once('open', () => (ws.close(), resolve(true)));
      ws.once('error', () => resolve(false));
    });

  it('allows configured origins, same-origin and non-browser clients; rejects foreign sites', async () => {
    expect(await tryOpen('https://school.example')).toBe(true);
    expect(await tryOpen(`http://127.0.0.1:${port}`)).toBe(true);
    expect(await tryOpen()).toBe(true);
    expect(await tryOpen('https://evil.example')).toBe(false);
  });
});
