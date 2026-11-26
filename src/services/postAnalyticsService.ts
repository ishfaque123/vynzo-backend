import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';
import { getActiveBoostPostInfo } from './boostService';

// Repeat-view throttle for boosted posts (owner order 2026-11-26): at
// most one counted repeat view per viewer per boost per 10 minutes.
const REPEAT_VIEW_WINDOW_MS = 10 * 60 * 1000;

export async function recordPostView(userId: string, postId: string, watchSec: number = 0) {
  const post = await prisma.post.findUnique({ where: { id: postId }, select: { id: true } });
  if (!post) throw new ApiError(404, 'POST_NOT_FOUND', 'Post not found.');
  const ws = Math.max(0, Math.min(3600, Math.floor(Number(watchSec) || 0)));
  const now = new Date();

  // The postView upsert is unchanged: post_views counts unique viewers
  // only (createdAt stays the FIRST view; lastViewedAt refreshes on
  // every view for the boost 6h repeat rule; watchSec accumulates).
  // Whether this call is a repeat view is decided inside the same
  // transaction as the upsert, so a concurrent first view cannot be
  // mistaken for a repeat — and a first view is never recorded twice.
  await prisma.$transaction(async (tx) => {
    const existing = await tx.postView.findUnique({
      where: { postId_viewerId: { postId, viewerId: userId } },
      select: { id: true },
    });
    await tx.postView.upsert({
      where: { postId_viewerId: { postId, viewerId: userId } },
      // Refresh lastViewedAt on every view: the boost 6h repeat rule reads
      // it (see getStaleViewedPostIds). createdAt stays the FIRST view.
      update: { watchSec: { increment: ws }, lastViewedAt: now },
      create: { postId, viewerId: userId, watchSec: ws },
    });
    // First view — post_views counts it; no repeat row is written.
    if (!existing) return;

    // Repeat view: it only counts toward the ad when the post has a
    // live boost, the viewer is not the boost owner, and no repeat
    // was counted for this viewer + boost inside the last 10 minutes.
    // A failed boost lookup is treated as "no live boost" (the view
    // itself is still recorded above) — the same defensive pattern as
    // the feed's getActiveBoostPostInfo(...).catch(() => null).
    const info = await getActiveBoostPostInfo([postId]).catch(() => new Map());
    const boost = info.get(postId);
    if (!boost || boost.userId === userId) return;
    const windowStart = new Date(now.getTime() - REPEAT_VIEW_WINDOW_MS);
    const recent = await tx.postBoostView.findFirst({
      where: { boostId: boost.boostId, viewerId: userId, viewedAt: { gte: windowStart } },
      select: { id: true },
    });
    if (recent) return;
    try {
      await tx.postBoostView.create({
        data: {
          boostId: boost.boostId,
          postId,
          viewerId: userId,
          // 10-minute bucket — the unique index on
          // (boostId, viewerId, tenMinBucket) is the race backstop for
          // the rolling check above (same pattern as BoostLinkClick's
          // hourBucket): a concurrent repeat in the same bucket
          // inserts nothing instead of double-counting.
          tenMinBucket: Math.floor(now.getTime() / REPEAT_VIEW_WINDOW_MS),
          viewedAt: now,
        },
      });
    } catch (err: any) {
      if (err?.code === 'P2002') return; // Same bucket counted concurrently.
      throw err;
    }
  });

  const viewCount = await prisma.postView.count({ where: { postId } });
  return { viewed: true, viewCount };
}
