import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';

export async function toggleFollow(followerId: string, followingId: string) {
  if (followerId === followingId) {
    throw new ApiError(400, 'INVALID_ACTION', 'You cannot follow yourself.');
  }

  const target = await prisma.user.findUnique({ where: { id: followingId } });
  if (!target) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found.');

  const existing = await prisma.follow.findUnique({
    where: { followerId_followingId: { followerId, followingId } },
  });

  if (existing) {
    await prisma.follow.delete({ where: { id: existing.id } });
    return { following: false };
  } else {
    await prisma.follow.create({ data: { followerId, followingId } });
    return { following: true };
  }
}

export async function getFollowCounts(userId: string) {
  const [followers, following] = await Promise.all([
    prisma.follow.count({ where: { followingId: userId } }),
    prisma.follow.count({ where: { followerId: userId } }),
  ]);
  return { followers, following };
}

export async function isFollowing(followerId: string, followingId: string) {
  const existing = await prisma.follow.findUnique({
    where: { followerId_followingId: { followerId, followingId } },
  });
  return !!existing;
}
