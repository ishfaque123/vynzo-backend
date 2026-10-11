import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';

const userSelect = { id: true, username: true, displayName: true, profilePictureUrl: true };

/** Mute someone's stories (not a block — you stay connected, just hide their stories). */
export async function muteStories(userId: string, mutedUserId: string) {
  if (mutedUserId === userId) throw new ApiError(400, 'INVALID_TARGET', 'You cannot mute yourself.');
  const target = await prisma.user.findUnique({ where: { id: mutedUserId }, select: { id: true } });
  if (!target) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found.');
  await prisma.statusMute.upsert({
    where: { userId_mutedUserId: { userId, mutedUserId } },
    update: {},
    create: { userId, mutedUserId },
  });
  return { muted: true };
}

export async function unmuteStories(userId: string, mutedUserId: string) {
  await prisma.statusMute.deleteMany({ where: { userId, mutedUserId } });
  return { muted: false };
}

export async function getMutedStories(userId: string) {
  const rows = await prisma.statusMute.findMany({
    where: { userId },
    include: { mutedUser: { select: userSelect } },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map((r) => r.mutedUser);
}

/** Returns the set of user IDs whose stories the viewer muted (for feed filtering). */
export async function getMutedUserIds(userId: string): Promise<Set<string>> {
  const rows = await prisma.statusMute.findMany({ where: { userId }, select: { mutedUserId: true } });
  return new Set(rows.map((r) => r.mutedUserId));
}
