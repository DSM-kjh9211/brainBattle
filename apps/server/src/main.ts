import { mkdirSync } from 'node:fs';
import { buildServer } from './app.js';
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.databaseUrl.startsWith('pglite://') && !config.databaseUrl.endsWith('memory')) {
    mkdirSync(config.databaseUrl.slice('pglite://'.length), { recursive: true });
  }
  const server = await buildServer(config);
  server.manager.startMaintenance();
  // resume deadlines/timers of sessions whose previous owner crashed
  const recovered = await server.manager.recoverOrphans();
  if (recovered.length) server.app.log.info({ recovered }, 'recovered live sessions');
  await server.app.listen({ host: config.host, port: config.port });
  server.app.log.info(`BrainBattle server (${config.nodeId}) listening on ${config.host}:${config.port}, db=${config.databaseUrl.split('@').pop()}`);

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    server.app.log.info({ signal }, 'shutting down (flushing sessions, releasing leases)');
    await server.close().catch((e) => console.error(e));
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
