import http from 'http';
import { app } from './app';
import { env } from './config/env';
import { prisma } from './config/prisma';
import { initSocketServer } from './socket/socketServer';
import { cleanupExpiredStatuses } from './services/statusService';

async function start() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    console.log('Database connection successful.');

    const httpServer = http.createServer(app);
    initSocketServer(httpServer);

    httpServer.listen(env.port, () => {
      console.log(`Vynzo backend running on port ${env.port} (${env.nodeEnv})`);
    });

    const STATUS_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // hourly
    async function runStatusCleanup() {
      try {
        const result = await cleanupExpiredStatuses();
        if (result.deleted) console.log(`Cleaned up ${result.deleted} expired status(es).`);
      } catch (err) {
        console.error('Status cleanup failed:', err);
      }
    }
    runStatusCleanup();
    setInterval(runStatusCleanup, STATUS_CLEANUP_INTERVAL_MS);
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
