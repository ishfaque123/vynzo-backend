import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';

export async function blockUser(blockerId: string, blockedId: string) {
  if (blockerId === blockedId) {
    throw new ApiError(400, 'INVALID_TARGET', 'You cannot block yourself.');
  }
  const target = await prisma.user.findUnique({ where: { id: blockedId } });
  if (!target) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found.');

  await prisma.block.upsert({
    where: { blockerId_blockedId: { blockerId, blockedId } },
    update: {},
    create: { blockerId, blockedId },
  });

  // Blocking also removes any follow relationship in either direction
  await prisma.follow.deleteMany({
    where: {
      OR: [
        { followerId: blockerId, followingId: blockedId },
        { followerId: blockedId, followingId: blockerId },
      ],
    },
  });

  return { blocked: true };
}

export async function unblockUser(blockerId: string, blockedId: string) {
  await prisma.block.deleteMany({ where: { blockerId, blockedId } });
  return { blocked: false };
}

export async function getBlockStatus(userId: string, otherUserId: string) {
  const [blockedByMe, blockedByOther] = await Promise.all([
    prisma.block.findUnique({ where: { blockerId_blockedId: { blockerId: userId, blockedId: otherUserId } } }),
    prisma.block.findUnique({ where: { blockerId_blockedId: { blockerId: otherUserId, blockedId: userId } } }),
  ]);
  return { blockedByMe: !!blockedByMe, blockedByOther: !!blockedByOther };
}

export async function isEitherBlocked(userIdA: string, userIdB: string): Promise<boolean> {
  const count = await prisma.block.count({
    where: {
      OR: [
        { blockerId: userIdA, blockedId: userIdB },
        { blockerId: userIdB, blockedId: userIdA },
      ],
    },
  });
  return count > 0;
}
