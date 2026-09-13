import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';
import { env } from '../config/env';
import { deleteFromR2 } from '../config/r2';

const authorSelect = { id: true, username: true, displayName: true, profilePictureUrl: true };

export async function getReelsConfig() {
  return {
    enabled: env.reelsEnabled,
    maxDurationSec: env.reelMaxDurationSec,
    dailyLimit: env.reelDailyLimit,
  };
}

export async function createReel(userId: string, data: { videoUrl: string; caption?: string; durationSec?: number }) {
  if (!env.reelsEnabled) throw new ApiError(403, 'REELS_DISABLED', 'Reels are currently unavailable.');

  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentCount = await prisma.reel.count({ where: { userId, createdAt: { gt: oneDayAgo } } });
  if (recentCount >= env.reelDailyLimit) {
    throw new ApiError(
      429,
      'DAILY_LIMIT_REACHED',
      `You can only post ${env.reelDailyLimit} reel${env.reelDailyLimit === 1 ? '' : 's'} per day. Try again later.`
    );
  }

  return prisma.reel.create({
    data: { userId, videoUrl: data.videoUrl, caption: data.caption, durationSec: data.durationSec },
  });
}

export async function getReelFeed(currentUserId: string, limit = 10, offset = 0) {
  const blockedRows = await prisma.block.findMany({
    where: { OR: [{ blockerId: currentUserId }, { blockedId: currentUserId }] },
    select: { blockerId: true, blockedId: true },
  });
  const blockedIds = new Set<string>();
  for (const b of blockedRows) {
    blockedIds.add(b.blockerId === currentUserId ? b.blockedId : b.blockerId);
  }
  const where = blockedIds.size ? { userId: { notIn: [...blockedIds] } } : {};

  const [reels, total] = await Promise.all([
    prisma.reel.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: offset,
      take: limit,
      include: {
        user: { select: authorSelect },
        _count: { select: { likes: true } },
        likes: { where: { userId: currentUserId }, select: { id: true } },
      },
    }),
    prisma.reel.count({ where }),
  ]);

  return {
    reels: reels.map((r) => ({
      id: r.id,
      videoUrl: r.videoUrl,
      caption: r.caption,
      durationSec: r.durationSec,
      createdAt: r.createdAt,
      likeCount: r._count.likes,
      liked: r.likes.length > 0,
      isMine: r.userId === currentUserId,
      author: r.user,
    })),
    hasMore: offset + reels.length < total,
  };
}

export async function toggleReelLike(userId: string, reelId: string) {
  const reel = await prisma.reel.findUnique({ where: { id: reelId } });
  if (!reel) throw new ApiError(404, 'REEL_NOT_FOUND', 'Reel not found.');

  const existing = await prisma.reelLike.findUnique({ where: { reelId_userId: { reelId, userId } } });
  if (existing) {
    await prisma.reelLike.delete({ where: { id: existing.id } });
    return { liked: false };
  }
  await prisma.reelLike.create({ data: { reelId, userId } });
  return { liked: true };
}

export async function deleteReel(userId: string, reelId: string) {
  const reel = await prisma.reel.findUnique({ where: { id: reelId } });
  if (!reel) throw new ApiError(404, 'REEL_NOT_FOUND', 'Reel not found.');
  if (reel.userId !== userId) throw new ApiError(403, 'FORBIDDEN', 'Not your reel.');
  await prisma.reel.delete({ where: { id: reelId } });
  if (reel.videoUrl) {
    try {
      await deleteFromR2(reel.videoUrl);
    } catch (err) {
      console.error('Failed to delete reel video from R2:', err);
    }
  }
  return { deleted: true };
}

export async function getMyDailyReelStatus(userId: string) {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const count = await prisma.reel.count({ where: { userId, createdAt: { gt: oneDayAgo } } });
  return { postedToday: count, remaining: Math.max(0, env.reelDailyLimit - count) };
}
