import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';
import { env } from '../config/env';
import { deleteFromR2 } from '../config/r2';
import { getFriendStatus } from './followService';
import { isEitherBlocked } from './blockService';

const authorSelect = { id: true, username: true, displayName: true, profilePictureUrl: true };

export async function addReelComment(userId: string, reelId: string, content: string) {
  const reel = await prisma.reel.findUnique({ where: { id: reelId } });
  if (!reel) throw new ApiError(404, 'REEL_NOT_FOUND', 'Reel not found.');
  if (await isEitherBlocked(userId, reel.userId)) throw new ApiError(403, 'BLOCKED', 'Cannot comment on this reel.');
  const trimmed = content.trim();
  if (!trimmed) throw new ApiError(400, 'EMPTY_COMMENT', 'Comment cannot be empty.');
  return prisma.reelComment.create({ data: { reelId, userId, content: trimmed }, include: { user: { select: authorSelect } } });
}

export async function getReelComments(reelId: string) {
  return prisma.reelComment.findMany({ where: { reelId }, orderBy: { createdAt: 'asc' }, include: { user: { select: authorSelect } } });
}

export async function deleteReelComment(userId: string, commentId: string) {
  const comment = await prisma.reelComment.findUnique({ where: { id: commentId }, include: { reel: true } });
  if (!comment) throw new ApiError(404, 'COMMENT_NOT_FOUND', 'Comment not found.');
  if (comment.userId !== userId && comment.reel.userId !== userId) throw new ApiError(403, 'FORBIDDEN', 'You cannot delete this comment.');
  await prisma.reelComment.delete({ where: { id: commentId } });
  return { deleted: true };
}

export async function getReelsConfig() {
  return { enabled: env.reelsEnabled, maxDurationSec: env.reelMaxDurationSec, dailyLimit: env.reelDailyLimit };
}

export async function createReel(userId: string, data: { videoUrl: string; caption?: string; durationSec: number }) {
  if (!env.reelsEnabled) throw new ApiError(403, 'REELS_DISABLED', 'Reels are currently unavailable.');

  if (!Number.isInteger(data.durationSec) || data.durationSec <= 0 || data.durationSec > env.reelMaxDurationSec) {
    throw new ApiError(400, 'INVALID_DURATION', `Reel duration must be between 1 and ${env.reelMaxDurationSec} seconds.`);
  }

  // Serializable transaction makes the daily-limit check atomic against
  // concurrent uploads for the same user.
  return prisma.$transaction(async (tx) => {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentCount = await tx.reel.count({ where: { userId, createdAt: { gt: oneDayAgo } } });
    if (recentCount >= env.reelDailyLimit) {
      throw new ApiError(429, 'DAILY_LIMIT_REACHED', `You can only post ${env.reelDailyLimit} reel${env.reelDailyLimit === 1 ? '' : 's'} per day. Try again later.`);
    }

    return tx.reel.create({ data: { userId, videoUrl: data.videoUrl, caption: data.caption, durationSec: data.durationSec } });
  }, { isolationLevel: 'Serializable' });
}

export async function getReelFeed(currentUserId: string, limit = 10, offset = 0) {
  const blockedRows = await prisma.block.findMany({
    where: { OR: [{ blockerId: currentUserId }, { blockedId: currentUserId }] },
    select: { blockerId: true, blockedId: true },
  });
  const blockedIds = new Set<string>();
  for (const b of blockedRows) blockedIds.add(b.blockerId === currentUserId ? b.blockedId : b.blockerId);
  const where = blockedIds.size ? { userId: { notIn: [...blockedIds] } } : {};
  const safeLimit = Math.min(Math.max(limit, 1), 20);
  const safeOffset = Math.max(offset, 0);

  const [reels, total] = await Promise.all([
    prisma.reel.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: safeOffset,
      take: safeLimit,
      include: {
        user: { select: authorSelect },
        _count: { select: { likes: true, comments: true } },
        likes: { where: { userId: currentUserId }, select: { id: true } },
        favorites: { where: { userId: currentUserId }, select: { id: true } },
      },
    }),
    prisma.reel.count({ where }),
  ]);

  const reelsWithStatus = await Promise.all(reels.map(async (r) => ({
    id: r.id,
    videoUrl: r.videoUrl,
    caption: r.caption,
    durationSec: r.durationSec,
    createdAt: r.createdAt,
    likeCount: r._count.likes,
    commentCount: r._count.comments,
    liked: r.likes.length > 0,
    favorited: r.favorites.length > 0,
    isMine: r.userId === currentUserId,
    author: r.user,
    friendStatus: await getFriendStatus(currentUserId, r.userId),
  })));

  return { reels: reelsWithStatus, hasMore: safeOffset + reels.length < total };
}

export async function toggleReelLike(userId: string, reelId: string) {
  const reel = await prisma.reel.findUnique({ where: { id: reelId } });
  if (!reel) throw new ApiError(404, 'REEL_NOT_FOUND', 'Reel not found.');
  if (await isEitherBlocked(userId, reel.userId)) throw new ApiError(403, 'BLOCKED', 'Cannot like this reel.');

  const existing = await prisma.reelLike.findUnique({ where: { reelId_userId: { reelId, userId } } });
  if (existing) {
    await prisma.reelLike.delete({ where: { id: existing.id } });
    return { liked: false };
  }
  await prisma.reelLike.create({ data: { reelId, userId } });
  return { liked: true };
}

export async function toggleReelFavorite(userId: string, reelId: string) {
  const reel = await prisma.reel.findUnique({ where: { id: reelId } });
  if (!reel) throw new ApiError(404, 'REEL_NOT_FOUND', 'Reel not found.');
  if (await isEitherBlocked(userId, reel.userId)) throw new ApiError(403, 'BLOCKED', 'Cannot favorite this reel.');

  const existing = await prisma.reelFavorite.findUnique({ where: { reelId_userId: { reelId, userId } } });
  if (existing) {
    await prisma.reelFavorite.delete({ where: { id: existing.id } });
    return { favorited: false };
  }
  await prisma.reelFavorite.create({ data: { reelId, userId } });
  return { favorited: true };
}

export async function getMyFavoriteReels(userId: string) {
  const favorites = await prisma.reelFavorite.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    include: { reel: { include: { user: { select: authorSelect }, _count: { select: { likes: true, comments: true } }, likes: { where: { userId }, select: { id: true } } } } },
  });
  return favorites.filter((f) => f.reel).map((f) => ({
    id: f.reel.id,
    videoUrl: f.reel.videoUrl,
    caption: f.reel.caption,
    durationSec: f.reel.durationSec,
    createdAt: f.reel.createdAt,
    likeCount: f.reel._count.likes,
    commentCount: f.reel._count.comments,
    liked: f.reel.likes.length > 0,
    favorited: true,
    isMine: f.reel.userId === userId,
    author: f.reel.user,
  }));
}

export async function deleteReel(userId: string, reelId: string) {
  const reel = await prisma.reel.findUnique({ where: { id: reelId } });
  if (!reel) throw new ApiError(404, 'REEL_NOT_FOUND', 'Reel not found.');
  if (reel.userId !== userId) throw new ApiError(403, 'FORBIDDEN', 'Not your reel.');
  await prisma.reel.delete({ where: { id: reelId } });
  if (reel.videoUrl) {
    try { await deleteFromR2(reel.videoUrl); } catch (err) { console.error('Failed to delete reel video from R2:', err); }
  }
  return { deleted: true };
}

export async function getMyDailyReelStatus(userId: string) {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const count = await prisma.reel.count({ where: { userId, createdAt: { gt: oneDayAgo } } });
  return { postedToday: count, remaining: Math.max(0, env.reelDailyLimit - count) };
}
