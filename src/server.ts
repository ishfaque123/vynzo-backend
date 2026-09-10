import http from 'http';
import { app } from './app';
import { env } from './config/env';
import { prisma } from './config/prisma';
import { initSocketServer } from './socket/socketServer';

async function start() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    console.log('Database connection successful.');

    const httpServer = http.createServer(app);
    initSocketServer(httpServer);

    httpServer.listen(env.port, () => {
      console.log(`Vynzo backend running on port ${env.port} (${env.nodeEnv})`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
