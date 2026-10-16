import http from 'http';
import { app } from './app';
import { env } from './config/env';
import { prisma } from './config/prisma';
import { initSocketServer } from './socket/socketServer';
import { cleanupExpiredStatuses } from './services/statusService';
import { cleanupExpiredMessages } from './services/messageCleanupService';
import { ensureModerationSchema } from './services/moderationService';
import { ensureViralPostSchema, checkViralPosts } from './services/viralPostService';
import { seedPosterAgents, runPosterCycle, POSTER_CYCLE_MS, runLikeCycle, LIKE_CYCLE_MS } from './services/aiPosterService';
import { seedOutreachAgents, runOutreachCycle, OUTREACH_CYCLE_MS, seedOfficialFollows } from './services/aiOutreachService';

async function start() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    console.log('Database connection successful.');

    // Ensure moderation tables/columns exist (safe, idempotent)
    await ensureModerationSchema();

    // Ensure viral_post notification type exists (safe, idempotent)
    await ensureViralPostSchema();

    // Seed the 10 AI poster accounts (safe, idempotent)
    await seedPosterAgents();

    // Seed the 4 AI outreach accounts (safe, idempotent)
    await seedOutreachAgents();

    // Official @frianzo follows all AI accounts (safe, idempotent)
    await seedOfficialFollows();

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

    const VIRAL_CHECK_INTERVAL_MS = 15 * 60 * 1000; // every 15 minutes
    async function runViralCheck() {
      try {
        await checkViralPosts();
      } catch (err) {
        console.error('Viral post check failed:', err);
      }
    }
    runViralCheck();
    setInterval(runViralCheck, VIRAL_CHECK_INTERVAL_MS);

    // AI poster accounts: ~1 original post/day each, staggered
    async function runPoster() {
      try {
        await runPosterCycle();
      } catch (err) {
        console.error('AI poster cycle failed:', err);
      }
    }
    // Small delay so startup isn't blocked, then every 4 hours
    setTimeout(runPoster, 2 * 60 * 1000);
    setInterval(runPoster, POSTER_CYCLE_MS);

    // AI agents like posts too (like real active users)
    async function runLikes() {
      try {
        await runLikeCycle();
      } catch (err) {
        console.error('AI like cycle failed:', err);
      }
    }
    setTimeout(runLikes, 10 * 60 * 1000);
    setInterval(runLikes, LIKE_CYCLE_MS);

    // AI outreach accounts: one-time friendly follow invite per user, daily
    async function runOutreach() {
      try {
        await runOutreachCycle();
      } catch (err) {
        console.error('AI outreach cycle failed:', err);
      }
    }
    setTimeout(runOutreach, 5 * 60 * 1000);
    setInterval(runOutreach, OUTREACH_CYCLE_MS);

    const MESSAGE_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
    async function runMessageCleanup() {
      try {
        const result = await cleanupExpiredMessages();
        if (result.deleted) console.log(`Cleaned up ${result.deleted} Messenger message(s) older than 30 days.`);
      } catch (err) {
        console.error('Messenger message cleanup failed:', err);
      }
    }
    runMessageCleanup();
    setInterval(runMessageCleanup, MESSAGE_CLEANUP_INTERVAL_MS);
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
