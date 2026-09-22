import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';
import { isEitherBlocked } from './blockService';
import { deleteFromR2 } from '../config/r2';

const STATUS_LIFETIME_MS = 24 * 60 * 60 * 1000;
const DAILY_STATUS_LIMIT = 20;
const authorSelect = { id: true, username: true, displayName: true, profilePictureUrl: true };

export async function createStatus(userId: string, data: { mediaUrl?: string; mediaType?: string; textContent?: string; bgColor?: string; visibility?: string }) {
  if (!data.mediaUrl && !data.textContent) throw new ApiError(400, 'EMPTY_STATUS', 'Status must have media or text.');

  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentCount = await prisma.status.count({ where: { userId, createdAt: { gt: oneDayAgo } } });
  if (recentCount >= DAILY_STATUS_LIMIT) {
    throw new ApiError(429, 'DAILY_LIMIT_REACHED', `You can only post ${DAILY_STATUS_LIMIT} statuses per day. Try again later.`);
  }

  const visibility = data.visibility === 'close_friends' ? 'close_friends' : 'everyone';
  const expiresAt = new Date(Date.now() + STATUS_LIFETIME_MS);
  return prisma.status.create({
    data: { userId, mediaUrl: data.mediaUrl, mediaType: data.mediaType || (data.mediaUrl ? 'image' : 'text'), textContent: data.textContent, bgColor: data.bgColor, visibility, expiresAt },
  });
}

export async function getStatusFeed(userId: string) {
  const following = await prisma.follow.findMany({ where: { followerId: userId }, select: { followingId: true } });
  const authorIds = [...following.map((f) => f.followingId), userId];
  const statuses = await prisma.status.findMany({
    where: { userId: { in: authorIds }, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'asc' },
    include: { user: { select: authorSelect }, views: { select: { viewerId: true, liked: true } } },
  });
  const grouped: Record<string, any> = {};
  const closeFriendAuthorIds = [...new Set(statuses.filter((s) => s.visibility === 'close_friends' && s.userId !== userId).map((s) => s.userId))];
  const closeFriendChecks = closeFriendAuthorIds.length
    ? await prisma.closeFriend.findMany({ where: { ownerId: { in: closeFriendAuthorIds }, friendId: userId }, select: { ownerId: true } })
    : [];
  const allowedCloseFriendAuthors = new Set(closeFriendChecks.map((c) => c.ownerId));
  for (const s of statuses) {
    if (s.visibility === 'close_friends' && s.userId !== userId && !allowedCloseFriendAuthors.has(s.userId)) continue;
    if (!grouped[s.userId]) grouped[s.userId] = { user: s.user, items: [], hasUnseen: false };
    const myView = s.views.find((v) => v.viewerId === userId);
    const seen = !!myView;
    const liked = myView?.liked || false;
    const viewCount = s.userId === userId ? s.views.length : undefined;
    grouped[s.userId].items.push({ id: s.id, mediaUrl: s.mediaUrl, mediaType: s.mediaType, textContent: s.textContent, bgColor: s.bgColor, visibility: s.visibility, createdAt: s.createdAt, seen, liked, viewCount });
    if (!seen && s.userId !== userId) grouped[s.userId].hasUnseen = true;
  }
  const list = Object.entries(grouped).map(([uid, g]: any) => ({ userId: uid, ...g }));
  list.sort((a, b) => (a.userId === userId ? -1 : b.userId === userId ? 1 : (b.hasUnseen ? 1 : 0) - (a.hasUnseen ? 1 : 0)));
  return list;
}

export async function viewStatus(userId: string, statusId: string) {
  const status = await prisma.status.findUnique({ where: { id: statusId } });
  if (!status) throw new ApiError(404, 'STATUS_NOT_FOUND', 'Status not found.');
  if (status.userId === userId) return { viewed: true };
  const blocked = await isEitherBlocked(userId, status.userId);
  if (blocked) throw new ApiError(403, 'BLOCKED', 'Cannot view this status.');
  await prisma.statusView.upsert({ where: { statusId_viewerId: { statusId, viewerId: userId } }, update: {}, create: { statusId, viewerId: userId } });
  return { viewed: true };
}

export async function getStatusViewers(userId: string, statusId: string) {
  const status = await prisma.status.findUnique({ where: { id: statusId } });
  if (!status) throw new ApiError(404, 'STATUS_NOT_FOUND', 'Status not found.');
  if (status.userId !== userId) throw new ApiError(403, 'FORBIDDEN', 'Not your status.');
  const views = await prisma.statusView.findMany({ where: { statusId }, include: { viewer: { select: authorSelect } }, orderBy: { viewedAt: 'desc' } });
  return views.map((v) => ({ ...v.viewer, viewedAt: v.viewedAt, liked: v.liked }));
}

export async function toggleStatusLike(userId: string, statusId: string) {
  const status = await prisma.status.findUnique({ where: { id: statusId } });
  if (!status) throw new ApiError(404, 'STATUS_NOT_FOUND', 'Status not found.');
  if (status.userId === userId) throw new ApiError(400, 'CANNOT_LIKE_OWN', 'You cannot like your own status.');
  const blocked = await isEitherBlocked(userId, status.userId);
  if (blocked) throw new ApiError(403, 'BLOCKED', 'Cannot like this status.');

  const existing = await prisma.statusView.findUnique({ where: { statusId_viewerId: { statusId, viewerId: userId } } });
  const nextLiked = !existing?.liked;
  await prisma.statusView.upsert({
    where: { statusId_viewerId: { statusId, viewerId: userId } },
    update: { liked: nextLiked },
    create: { statusId, viewerId: userId, liked: nextLiked },
  });
  return { liked: nextLiked };
}

export async function deleteStatus(userId: string, statusId: string) {
  const status = await prisma.status.findUnique({ where: { id: statusId } });
  if (!status) throw new ApiError(404, 'STATUS_NOT_FOUND', 'Status not found.');
  if (status.userId !== userId) throw new ApiError(403, 'FORBIDDEN', 'Not your status.');

  // Delete the media object as part of manual status deletion, matching
  // the existing expired-status cleanup behavior.
  if (status.mediaUrl) {
    try {
      await deleteFromR2(status.mediaUrl);
    } catch (err) {
      console.error('Failed to delete manually deleted status media from R2:', err);
    }
  }

  await prisma.status.delete({ where: { id: statusId } });
  return { deleted: true };
}

// Runs periodically (see server.ts) to purge statuses whose 24-hour
// lifetime has passed: removes the media file from R2 storage first,
// then the database rows (StatusView rows cascade-delete automatically).
export async function cleanupExpiredStatuses() {
  const expired = await prisma.status.findMany({
    where: { expiresAt: { lt: new Date() } },
    select: { id: true, mediaUrl: true },
  });

  for (const s of expired) {
    if (s.mediaUrl) {
      try {
        await deleteFromR2(s.mediaUrl);
      } catch (err) {
        console.error('Failed to delete expired status media from R2:', err);
      }
    }
  }

  if (expired.length) {
    await prisma.status.deleteMany({ where: { id: { in: expired.map((s) => s.id) } } });
  }

  return { deleted: expired.length };
}
