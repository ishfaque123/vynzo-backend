import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';

function toHighlightDTO(h: any) {
  return {
    id: h.id,
    title: h.title,
    coverUrl: h.coverUrl,
    createdAt: h.createdAt,
    itemCount: h._count?.items ?? h.items?.length ?? 0,
    items: (h.items || []).map((i: any) => ({
      id: i.id,
      mediaUrl: i.mediaUrl,
      mediaType: i.mediaType,
      createdAt: i.createdAt,
    })),
  };
}

export async function getUserHighlights(username: string) {
  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found.');
  const highlights = await prisma.highlight.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'asc' },
    include: { items: { orderBy: { createdAt: 'asc' } }, _count: { select: { items: true } } },
  });
  return highlights.map(toHighlightDTO);
}

export async function createHighlight(userId: string, title: string, statusIds: string[]) {
  if (!title.trim()) throw new ApiError(400, 'TITLE_REQUIRED', 'Title is required.');
  // Only allow adding own non-expired statuses
  const statuses = await prisma.status.findMany({
    where: { id: { in: statusIds }, userId, expiresAt: { gt: new Date() } },
  });
  if (statuses.length === 0) throw new ApiError(400, 'NO_STATUSES', 'No valid statuses to add.');
  const firstWithMedia = statuses.find((s) => s.mediaUrl);
  const highlight = await prisma.highlight.create({
    data: {
      userId,
      title: title.trim().slice(0, 30),
      coverUrl: firstWithMedia?.mediaUrl || null,
      items: {
        create: statuses.map((s) => ({ mediaUrl: s.mediaUrl || '', mediaType: s.mediaType })),
      },
    },
    include: { items: { orderBy: { createdAt: 'asc' } }, _count: { select: { items: true } } },
  });
  return toHighlightDTO(highlight);
}

export async function deleteHighlight(userId: string, highlightId: string) {
  const highlight = await prisma.highlight.findUnique({ where: { id: highlightId } });
  if (!highlight) throw new ApiError(404, 'HIGHLIGHT_NOT_FOUND', 'Highlight not found.');
  if (highlight.userId !== userId) throw new ApiError(403, 'FORBIDDEN', 'Not your highlight.');
  await prisma.highlight.delete({ where: { id: highlightId } });
  return { deleted: true };
}

export async function addToHighlight(userId: string, highlightId: string, statusIds: string[]) {
  const highlight = await prisma.highlight.findUnique({ where: { id: highlightId } });
  if (!highlight) throw new ApiError(404, 'HIGHLIGHT_NOT_FOUND', 'Highlight not found.');
  if (highlight.userId !== userId) throw new ApiError(403, 'FORBIDDEN', 'Not your highlight.');
  const statuses = await prisma.status.findMany({
    where: { id: { in: statusIds }, userId, expiresAt: { gt: new Date() } },
  });
  if (statuses.length === 0) throw new ApiError(400, 'NO_STATUSES', 'No valid statuses to add.');
  await prisma.highlightItem.createMany({
    data: statuses.map((s) => ({ highlightId, mediaUrl: s.mediaUrl || '', mediaType: s.mediaType })),
  });
  const updated = await prisma.highlight.findUnique({
    where: { id: highlightId },
    include: { items: { orderBy: { createdAt: 'asc' } }, _count: { select: { items: true } } },
  });
  return toHighlightDTO(updated);
}

export async function removeFromHighlight(userId: string, highlightId: string, itemId: string) {
  const highlight = await prisma.highlight.findUnique({ where: { id: highlightId } });
  if (!highlight) throw new ApiError(404, 'HIGHLIGHT_NOT_FOUND', 'Highlight not found.');
  if (highlight.userId !== userId) throw new ApiError(403, 'FORBIDDEN', 'Not your highlight.');
  await prisma.highlightItem.deleteMany({ where: { id: itemId, highlightId } });
  return { removed: true };
}
