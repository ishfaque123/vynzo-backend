import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';

const userSelect = {
  id: true,
  username: true,
  displayName: true,
  profilePictureUrl: true,
};

export async function getCloseFriendCandidates(userId: string) {
  const [following, closeFriends] = await Promise.all([
    prisma.follow.findMany({
      where: { followerId: userId },
      include: { following: { select: userSelect } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.closeFriend.findMany({ where: { ownerId: userId }, select: { friendId: true } }),
  ]);

  const closeFriendIds = new Set(closeFriends.map((c) => c.friendId));

  return following.map((f) => ({
    ...f.following,
    isCloseFriend: closeFriendIds.has(f.following.id),
  }));
}

export async function addCloseFriend(ownerId: string, friendId: string) {
  if (ownerId === friendId) throw new ApiError(400, 'INVALID_TARGET', 'You cannot add yourself.');

  const isFollowing = await prisma.follow.findUnique({
    where: { followerId_followingId: { followerId: ownerId, followingId: friendId } },
  });
  if (!isFollowing) throw new ApiError(400, 'NOT_FOLLOWING', 'You can only add people you follow.');

  await prisma.closeFriend.upsert({
    where: { ownerId_friendId: { ownerId, friendId } },
    update: {},
    create: { ownerId, friendId },
  });
  return { added: true };
}

export async function removeCloseFriend(ownerId: string, friendId: string) {
  await prisma.closeFriend.deleteMany({ where: { ownerId, friendId } });
  return { removed: true };
}
