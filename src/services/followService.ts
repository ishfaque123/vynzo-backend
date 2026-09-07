import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';
import { createNotification } from './notificationService';

const FRIEND_LIMIT = 5000;

async function getFriendCount(userId: string): Promise<number> {
  const following = await prisma.follow.findMany({ where: { followerId: userId }, select: { followingId: true } });
  const followingIds = following.map((f) => f.followingId);
  if (followingIds.length === 0) return 0;
  return prisma.follow.count({ where: { followerId: { in: followingIds }, followingId: userId } });
}

export async function toggleFollow(followerId: string, followingId: string) {
  if (followerId === followingId) throw new ApiError(400, 'INVALID_ACTION', 'You cannot follow yourself.');

  const target = await prisma.user.findUnique({ where: { id: followingId } });
  if (!target) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found.');

  const existing = await prisma.follow.findUnique({ where: { followerId_followingId: { followerId, followingId } } });

  if (existing) {
    await prisma.follow.delete({ where: { id: existing.id } });
    return { following: false };
  }

  const reverseExists = await prisma.follow.findUnique({ where: { followerId_followingId: { followerId: followingId, followingId: followerId } } });
  if (reverseExists) {
    const [myFriends, theirFriends] = await Promise.all([getFriendCount(followerId), getFriendCount(followingId)]);
    if (myFriends >= FRIEND_LIMIT || theirFriends >= FRIEND_LIMIT) {
      throw new ApiError(403, 'FRIEND_LIMIT_REACHED', 'Friend limit of 5,000 reached.');
    }
  }

  await prisma.follow.create({ data: { followerId, followingId } });
  await createNotification({ userId: followingId, actorId: followerId, type: 'follow' });
  return { following: true };
}

export async function getFollowCounts(userId: string) {
  const [followers, following] = await Promise.all([
    prisma.follow.count({ where: { followingId: userId } }),
    prisma.follow.count({ where: { followerId: userId } }),
  ]);
  const friends = await getFriendCount(userId);
  return { followers, following, friends };
}

export async function getFriendStatus(currentUserId: string | undefined, otherUserId: string): Promise<'none' | 'following' | 'follow_back' | 'friends' | 'self'> {
  if (!currentUserId) return 'none';
  if (currentUserId === otherUserId) return 'self';

  const [iFollow, theyFollow] = await Promise.all([
    prisma.follow.findUnique({ where: { followerId_followingId: { followerId: currentUserId, followingId: otherUserId } } }),
    prisma.follow.findUnique({ where: { followerId_followingId: { followerId: otherUserId, followingId: currentUserId } } }),
  ]);

  if (iFollow && theyFollow) return 'friends';
  if (iFollow) return 'following';
  if (theyFollow) return 'follow_back';
  return 'none';
}
