import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';
import { isEitherBlocked } from './blockService';

const STATUS_LIFETIME_MS = 24 * 60 * 60 * 1000;
const authorSelect = { id: true, username: true, displayName: true, profilePictureUrl: true };

export async function createStatus(userId: string, data: { mediaUrl?: string; mediaType?: string; textContent?: string; bgColor?: string }) {
  if (!data.mediaUrl && !data.textContent) throw new ApiError(400, 'EMPTY_STATUS', 'Status must have media or text.');
  const expiresAt = new Date(Date.now() + STATUS_LIFETIME_MS);
  return prisma.status.create({
    data: { userId, mediaUrl: data.mediaUrl, mediaType: data.mediaType || (data.mediaUrl ? 'image' : 'text'), textContent: data.textContent, bgColor: data.bgColor, expiresAt },
  });
}

export async function getStatusFeed(userId: string) {
  const following = await prisma.follow.findMany({ where: { followerId: userId }, select: { followingId: true } });
  const authorIds = [...following.map((f) => f.followingId), userId];
  const statuses = await prisma.status.findMany({
    where: { userId: { in: authorIds }, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'asc' },
    include: { user: { select: authorSelect }, views: { where: { viewerId: userId }, select: { id: true } } },
  });
  const grouped: Record<string, any> = {};
  for (const s of statuses) {
    if (!grouped[s.userId]) grouped[s.userId] = { user: s.user, items: [], hasUnseen: false };
    const seen = s.views.length > 0;
    grouped[s.userId].items.push({ id: s.id, mediaUrl: s.mediaUrl, mediaType: s.mediaType, textContent: s.textContent, bgColor: s.bgColor, createdAt: s.createdAt, seen });
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
  return views.map((v) => ({ ...v.viewer, viewedAt: v.viewedAt }));
}

export async function deleteStatus(userId: string, statusId: string) {
  const status = await prisma.status.findUnique({ where: { id: statusId } });
  if (!status) throw new ApiError(404, 'STATUS_NOT_FOUND', 'Status not found.');
  if (status.userId !== userId) throw new ApiError(403, 'FORBIDDEN', 'Not your status.');
  await prisma.status.delete({ where: { id: statusId } });
  return { deleted: true };
}
