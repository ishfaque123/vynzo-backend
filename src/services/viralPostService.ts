import { prisma } from '../config/prisma';
import { createNotification, isPushEnabled } from './notificationService';

/**
 * Ensures the `viral_post` value exists in the notifications.type ENUM.
 * Safe and idempotent — reads the current ENUM definition and appends the
 * value only if missing. Called on server startup.
 */
export async function ensureViralPostSchema() {
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ COLUMN_TYPE: string }>>(
      `SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notifications' AND COLUMN_NAME = 'type'`
    );
    const colType = rows[0]?.COLUMN_TYPE || '';
    if (colType.includes('viral_post')) return;
    const match = colType.match(/^enum\((.*)\)$/i);
    if (!match) {
      console.warn('[schema] notifications.type is not an ENUM, skipping viral_post ensure');
      return;
    }
    await prisma.$executeRawUnsafe(
      `ALTER TABLE notifications MODIFY COLUMN type ENUM(${match[1]},'viral_post') NOT NULL`
    );
    console.log('[schema] Added viral_post to notifications.type enum');
  } catch (err) {
    console.error('[schema] Failed to ensure viral_post enum:', err);
  }
}

const VIRAL_WINDOW_MIN = 60; // velocity measured over the last hour
const VIRAL_THRESHOLD = 10; // likes + comments*2 in the window to count as viral
const POST_MAX_AGE_HOURS = 48; // only fresh posts can go viral
const DAILY_CAP = 2; // max viral alerts per user per 24h

type ViralCandidate = {
  id: string;
  user_id: string;
  velocity: number;
};

/**
 * Finds posts with high engagement VELOCITY (not lifetime totals).
 * A post is viral when it gains a burst of likes/comments quickly.
 */
async function findViralCandidates(): Promise<ViralCandidate[]> {
  const windowStart = new Date(Date.now() - VIRAL_WINDOW_MIN * 60 * 1000);
  const maxAge = new Date(Date.now() - POST_MAX_AGE_HOURS * 60 * 60 * 1000);
  try {
    const rows = await prisma.$queryRawUnsafe<ViralCandidate[]>(
      `SELECT p.id, p.user_id,
        (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id AND l.created_at >= ?) +
        (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.created_at >= ?) * 2 AS velocity
      FROM posts p
      WHERE p.created_at >= ? AND p.visibility = 'public'
      HAVING velocity >= ?
      ORDER BY velocity DESC
      LIMIT 20`,
      windowStart, windowStart, maxAge, VIRAL_THRESHOLD
    );
    return rows.map((r) => ({ id: r.id, user_id: r.user_id, velocity: Number(r.velocity) || 0 }));
  } catch (err) {
    console.error('[viral] candidate query failed:', err);
    return [];
  }
}

/**
 * Checks for newly-viral posts and notifies relevant users (followers of the
 * author). Guarantees: one alert per post ever, one alert per user per post,
 * max DAILY_CAP alerts per user per 24h, respects the 'viral' preference.
 */
export async function checkViralPosts() {
  const candidates = await findViralCandidates();
  if (!candidates.length) return;

  for (const post of candidates) {
    try {
      // Skip posts that already triggered a viral alert (one alert per post ever)
      const alreadyAlerted = await prisma.notification.findFirst({
        where: { type: 'viral_post' as any, postId: post.id },
        select: { id: true },
      });
      if (alreadyAlerted) continue;

      // Recipients: followers of the author (excluding the author)
      const followers = await prisma.follow.findMany({
        where: { followingId: post.user_id },
        select: { followerId: true },
      });
      if (!followers.length) continue;

      // Users already notified for this post (extra safety)
      const notifiedRows = await prisma.notification.findMany({
        where: { type: 'viral_post' as any, postId: post.id },
        select: { userId: true },
      });
      const notifiedSet = new Set(notifiedRows.map((n) => n.userId));

      // Blocked relationships involving the author
      const blockRows = await prisma.block.findMany({
        where: { OR: [{ blockerId: post.user_id }, { blockedId: post.user_id }] },
        select: { blockerId: true, blockedId: true },
      });
      const blockedSet = new Set<string>();
      for (const b of blockRows) blockedSet.add(b.blockerId === post.user_id ? b.blockedId : b.blockerId);

      // Author info for the message
      const author = await prisma.user.findUnique({
        where: { id: post.user_id },
        select: { username: true, displayName: true },
      });
      const authorName = author?.username ? `@${author.username}` : 'Someone';

      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      let sent = 0;

      for (const f of followers) {
        const userId = f.followerId;
        if (userId === post.user_id) continue;
        if (blockedSet.has(userId)) continue;
        if (notifiedSet.has(userId)) continue;

        // Daily frequency cap
        const todayCount = await prisma.notification.count({
          where: { userId, type: 'viral_post' as any, createdAt: { gte: dayAgo } },
        });
        if (todayCount >= DAILY_CAP) continue;

        // Respect the user's viral-notification preference
        if (!(await isPushEnabled(userId, 'viral_post'))) continue;

        await createNotification({
          userId,
          actorId: post.user_id,
          type: 'viral_post' as any,
          postId: post.id,
          detail: `${authorName}'s post is going viral!`,
        } as any);
        sent++;
      }

      // Mark the post as alerted even if nobody was eligible, so we don't
      // re-scan it every 15 minutes forever. The marker is a notification
      // addressed to the author themselves (invisible-ish, no push needed
      // beyond normal flow).
      if (sent === 0) {
        await prisma.notification.create({
          data: {
            userId: post.user_id,
            actorId: post.user_id,
            type: 'viral_post' as any,
            postId: post.id,
            detail: 'viral-scan-marker',
            read: true,
          },
        }).catch(() => {});
      }

      console.log(`[viral] post ${post.id} velocity=${post.velocity} alerts_sent=${sent}`);
    } catch (err) {
      console.error(`[viral] failed for post ${post.id}:`, err);
    }
  }
}
