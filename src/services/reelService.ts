import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';
import { env } from '../config/env';
import { deleteFromR2 } from '../config/r2';
import { getFriendStatus } from './followService';
import { isEitherBlocked } from './blockService';
import { createNotification } from './notificationService';

const authorSelect = { id: true, username: true, displayName: true, profilePictureUrl: true, isVerified: true };

export async function addReelComment(userId: string, reelId: string, content: string, parentCommentId?: string) {
  const reel = await prisma.reel.findUnique({ where: { id: reelId } });
  if (!reel) throw new ApiError(404, 'REEL_NOT_FOUND', 'Reel not found.');
  if (await isEitherBlocked(userId, reel.userId)) throw new ApiError(403, 'BLOCKED', 'Cannot comment on this reel.');
  const trimmed = content.trim();
  if (!trimmed) throw new ApiError(400, 'EMPTY_COMMENT', 'Comment cannot be empty.');
  if (parentCommentId) {
    const parent = await prisma.reelComment.findUnique({ where: { id: parentCommentId }, select: { id: true, reelId: true } });
    if (!parent || parent.reelId !== reelId) throw new ApiError(400, 'INVALID_PARENT', 'Reply target is invalid.');
  }
  const created = await prisma.reelComment.create({ data: { reelId, userId, parentCommentId, content: trimmed }, include: { user: { select: authorSelect } } });
  try {
    if (parentCommentId) {
      const parentAuthor = await prisma.reelComment.findUnique({ where: { id: parentCommentId }, select: { userId: true } });
      if (parentAuthor) await createNotification({ userId: parentAuthor.userId, actorId: userId, type: 'reel_reply', reelId, commentId: parentCommentId });
    } else {
      await createNotification({ userId: reel.userId, actorId: userId, type: 'reel_comment', reelId });
    }
  } catch (err) {
    console.error('[notify] reel comment notification failed', err);
  }
  return created;
}

const REEL_COMMENT_PAGE_SIZE = 20;

function encodeReelCommentCursor(createdAt: Date, id: string) {
  return Buffer.from(JSON.stringify({ createdAt: createdAt.toISOString(), id }), 'utf8').toString('base64url');
}

function decodeReelCommentCursor(cursor?: string) {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed?.createdAt !== 'string' || typeof parsed?.id !== 'string') return null;
    const createdAt = new Date(parsed.createdAt);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id: parsed.id };
  } catch {
    return null;
  }
}

export async function getReelComments(reelId: string, currentUserId: string, cursor?: string, limit = REEL_COMMENT_PAGE_SIZE) {
  const safeLimit = Math.min(Math.max(limit, 1), REEL_COMMENT_PAGE_SIZE);
  const decodedCursor = decodeReelCommentCursor(cursor);
  if (cursor && !decodedCursor) throw new ApiError(400, 'INVALID_CURSOR', 'Invalid comment pagination cursor.');

  const rootWhere: any = { reelId, parentCommentId: null };
  if (decodedCursor) {
    rootWhere.OR = [
      { createdAt: { lt: decodedCursor.createdAt } },
      { createdAt: decodedCursor.createdAt, id: { lt: decodedCursor.id } },
    ];
  }

  const roots = await prisma.reelComment.findMany({
    where: rootWhere,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: safeLimit + 1,
    include: {
      user: { select: authorSelect },
      reactions: { select: { type: true, userId: true } },
    },
  });

  const hasMore = roots.length > safeLimit;
  const pageRoots = hasMore ? roots.slice(0, safeLimit) : roots;
  const rootIds = pageRoots.map((row) => row.id);

  const replies = rootIds.length
    ? await prisma.reelComment.findMany({
        where: { reelId, parentCommentId: { in: rootIds } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: {
          user: { select: authorSelect },
          reactions: { select: { type: true, userId: true } },
        },
      })
    : [];

  const nodes = new Map<string, any>();
  for (const row of [...pageRoots, ...replies]) {
    nodes.set(row.id, {
      id: row.id,
      reelId: row.reelId,
      content: row.content,
      createdAt: row.createdAt,
      author: row.user,
      reactionCount: row.reactions.length,
      myReaction: row.reactions.find((r) => r.userId === currentUserId)?.type ?? null,
      replies: [],
    });
  }

  for (const row of replies) {
    const parent = nodes.get(row.parentCommentId!);
    if (parent) parent.replies.push(nodes.get(row.id));
  }

  const result = pageRoots.map((row) => nodes.get(row.id));
  const last = pageRoots[pageRoots.length - 1];

  return {
    comments: result,
    pagination: {
      hasMore,
      nextCursor: hasMore && last ? encodeReelCommentCursor(last.createdAt, last.id) : null,
    },
  };
}

export async function toggleReelCommentReaction(userId: string, commentId: string, type: string) {
  const allowed = new Set(['like', 'love', 'haha', 'wow', 'sad', 'angry']);
  if (!allowed.has(type)) throw new ApiError(400, 'INVALID_REACTION', 'Invalid reaction type.');
  const comment = await prisma.reelComment.findUnique({ where: { id: commentId }, include: { reel: true } });
  if (!comment) throw new ApiError(404, 'COMMENT_NOT_FOUND', 'Comment not found.');
  if (await isEitherBlocked(userId, comment.reel.userId)) throw new ApiError(403, 'BLOCKED', 'Cannot react to this comment.');
  return prisma.$transaction(async (tx) => {
    const existing = await tx.reelCommentReaction.findUnique({ where: { userId_commentId: { userId, commentId } } });
    if (existing) {
      if (existing.type === type) {
        await tx.reelCommentReaction.delete({ where: { id: existing.id } });
        return { reaction: null };
      }
      const updated = await tx.reelCommentReaction.update({ where: { id: existing.id }, data: { type: type as any } });
      return { reaction: updated.type };
    }
    const created = await tx.reelCommentReaction.create({ data: { userId, commentId, type: type as any } });
    return { reaction: created.type };
  }, { isolationLevel: 'Serializable' });
}

export async function deleteReelComment(userId: string, commentId: string) {
  const comment = await prisma.reelComment.findUnique({ where: { id: commentId }, include: { reel: true } });
  if (!comment) throw new ApiError(404, 'COMMENT_NOT_FOUND', 'Comment not found.');
  if (comment.userId !== userId && comment.reel.userId !== userId) throw new ApiError(403, 'FORBIDDEN', 'You cannot delete this comment.');
  await prisma.reelComment.delete({ where: { id: commentId } });
  return { deleted: true };
}

export async function getReelsConfig() { return { enabled: env.reelsEnabled, maxDurationSec: env.reelMaxDurationSec, dailyLimit: env.reelDailyLimit }; }

export async function createReel(userId: string, data: { videoUrl: string; caption?: string; durationSec: number }) {
  if (!env.reelsEnabled) throw new ApiError(403, 'REELS_DISABLED', 'Reels are currently unavailable.');
  if (!Number.isInteger(data.durationSec) || data.durationSec <= 0 || data.durationSec > env.reelMaxDurationSec) throw new ApiError(400, 'INVALID_DURATION', `Reel duration must be between 1 and ${env.reelMaxDurationSec} seconds.`);
  return prisma.$transaction(async (tx) => {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentCount = await tx.reel.count({ where: { userId, createdAt: { gt: oneDayAgo } } });
    if (recentCount >= env.reelDailyLimit) throw new ApiError(429, 'DAILY_LIMIT_REACHED', `You can only post ${env.reelDailyLimit} reel${env.reelDailyLimit === 1 ? '' : 's'} per day. Try again later.`);
    return tx.reel.create({ data: { userId, videoUrl: data.videoUrl, caption: data.caption, durationSec: data.durationSec } });
  }, { isolationLevel: 'Serializable' });
}

export async function getReelFeed(currentUserId: string, limit = 10, offset = 0) {
  const blockedRows = await prisma.block.findMany({ where: { OR: [{ blockerId: currentUserId }, { blockedId: currentUserId }] }, select: { blockerId: true, blockedId: true } });
  const blockedIds = new Set<string>();
  for (const b of blockedRows) blockedIds.add(b.blockerId === currentUserId ? b.blockedId : b.blockerId);
  const where = blockedIds.size ? { userId: { notIn: [...blockedIds] } } : {};
  const safeLimit = Math.min(Math.max(limit, 1), 20);
  const safeOffset = Math.max(offset, 0);
  const [reels, total] = await Promise.all([
    prisma.reel.findMany({ where, orderBy: { createdAt: 'desc' }, skip: safeOffset, take: safeLimit, include: { user: { select: authorSelect }, _count: { select: { likes: true, comments: true } }, likes: { where: { userId: currentUserId }, select: { id: true } }, favorites: { where: { userId: currentUserId }, select: { id: true } } } }),
    prisma.reel.count({ where }),
  ]);
  const authorIds = [...new Set(reels.map((r) => r.userId))];
  const followRows = authorIds.length
    ? await prisma.follow.findMany({
        where: {
          OR: [
            { followerId: currentUserId, followingId: { in: authorIds } },
            { followerId: { in: authorIds }, followingId: currentUserId },
          ],
        },
        select: { followerId: true, followingId: true },
      })
    : [];
  const followingSet = new Set(followRows.filter((f) => f.followerId === currentUserId).map((f) => f.followingId));
  const followerSet = new Set(followRows.filter((f) => f.followingId === currentUserId).map((f) => f.followerId));

  const reelsWithStatus = reels.map((r) => {
    const isMine = r.userId === currentUserId;
    const iFollow = followingSet.has(r.userId);
    const theyFollow = followerSet.has(r.userId);
    const friendStatus = isMine ? 'self' : iFollow && theyFollow ? 'friends' : iFollow ? 'following' : theyFollow ? 'follow_back' : 'none';
    return { id: r.id, videoUrl: r.videoUrl, caption: r.caption, durationSec: r.durationSec, createdAt: r.createdAt, likeCount: r._count.likes, commentCount: r._count.comments, liked: r.likes.length > 0, favorited: r.favorites.length > 0, isMine, author: r.user, friendStatus };
  });
  return { reels: reelsWithStatus, hasMore: safeOffset + reels.length < total };
}

export async function toggleReelLike(userId: string, reelId: string) {
  const result = await toggleReelLikeCore(userId, reelId);
  if (result.liked) {
    try {
      const reel = await prisma.reel.findUnique({ where: { id: reelId }, select: { userId: true } });
      if (reel) await createNotification({ userId: reel.userId, actorId: userId, type: 'reel_like', reelId });
    } catch (err) {
      console.error('[notify] reel like notification failed', err);
    }
  }
  return result;
}

async function toggleReelLikeCore(userId: string, reelId: string) {
  const reel = await prisma.reel.findUnique({ where: { id: reelId } });
  if (!reel) throw new ApiError(404, 'REEL_NOT_FOUND', 'Reel not found.');
  if (await isEitherBlocked(userId, reel.userId)) throw new ApiError(403, 'BLOCKED', 'Cannot like this reel.');
  return prisma.$transaction(async (tx) => {
    const existing = await tx.reelLike.findUnique({ where: { reelId_userId: { reelId, userId } } });
    if (existing) await tx.reelLike.delete({ where: { id: existing.id } });
    else await tx.reelLike.create({ data: { reelId, userId } });
    const likeCount = await tx.reelLike.count({ where: { reelId } });
    return { liked: !existing, likeCount };
  }, { isolationLevel: 'Serializable' });
}

export async function toggleReelFavorite(userId: string, reelId: string) {
  const reel = await prisma.reel.findUnique({ where: { id: reelId } });
  if (!reel) throw new ApiError(404, 'REEL_NOT_FOUND', 'Reel not found.');
  if (await isEitherBlocked(userId, reel.userId)) throw new ApiError(403, 'BLOCKED', 'Cannot favorite this reel.');
  return prisma.$transaction(async (tx) => {
    const existing = await tx.reelFavorite.findUnique({ where: { reelId_userId: { reelId, userId } } });
    if (existing) {
      await tx.reelFavorite.delete({ where: { id: existing.id } });
      return { favorited: false };
    }
    await tx.reelFavorite.create({ data: { reelId, userId } });
    return { favorited: true };
  }, { isolationLevel: 'Serializable' });
}

export async function getMyFavoriteReels(userId: string) {
  const blockedRows = await prisma.block.findMany({ where: { OR: [{ blockerId: userId }, { blockedId: userId }] }, select: { blockerId: true, blockedId: true } });
  const blockedIds = new Set<string>();
  for (const b of blockedRows) blockedIds.add(b.blockerId === userId ? b.blockedId : b.blockerId);
  const favorites = await prisma.reelFavorite.findMany({ where: { userId, reel: blockedIds.size ? { userId: { notIn: [...blockedIds] } } : {} }, orderBy: { createdAt: 'desc' }, include: { reel: { include: { user: { select: authorSelect }, _count: { select: { likes: true, comments: true } }, likes: { where: { userId }, select: { id: true } } } } } });
  const reels = await Promise.all(favorites.filter((f) => f.reel).map(async (f) => ({
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
    friendStatus: await getFriendStatus(userId, f.reel.userId),
  })));
  return reels;
}

export async function deleteReel(userId: string, reelId: string) {
  const reel = await prisma.reel.findUnique({ where: { id: reelId } });
  if (!reel) throw new ApiError(404, 'REEL_NOT_FOUND', 'Reel not found.');
  if (reel.userId !== userId) throw new ApiError(403, 'FORBIDDEN', 'Not your reel.');
  await prisma.reel.delete({ where: { id: reelId } });
  if (reel.videoUrl) { try { await deleteFromR2(reel.videoUrl); } catch (err) { console.error('Failed to delete reel video from R2:', err); } }
  return { deleted: true };
}

export async function getMyDailyReelStatus(userId: string) {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const count = await prisma.reel.count({ where: { userId, createdAt: { gt: oneDayAgo } } });
  return { postedToday: count, remaining: Math.max(0, env.reelDailyLimit - count) };
}

export async function getReelsByUsername(username: string, currentUserId: string) {
  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found.');
  const isOwner = currentUserId === user.id;
  if (!isOwner) {
    if (await isEitherBlocked(currentUserId, user.id)) return [];
    if (user.isPrivate) {
      const friendStatus = await getFriendStatus(currentUserId, user.id);
      if (friendStatus !== 'following' && friendStatus !== 'friends') return [];
    }
  }
  const reels = await prisma.reel.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    include: {
      user: { select: authorSelect },
      _count: { select: { likes: true, comments: true } },
      likes: { where: { userId: currentUserId }, select: { id: true } },
      favorites: { where: { userId: currentUserId }, select: { id: true } },
    },
  });
  const friendStatus = isOwner ? 'self' : await getFriendStatus(currentUserId, user.id);
  return reels.map((r) => ({
    id: r.id,
    videoUrl: r.videoUrl,
    caption: r.caption,
    durationSec: r.durationSec,
    createdAt: r.createdAt,
    likeCount: r._count.likes,
    commentCount: r._count.comments,
    liked: r.likes.length > 0,
    favorited: r.favorites.length > 0,
    isMine: isOwner,
    author: r.user,
    friendStatus,
  }));
}
