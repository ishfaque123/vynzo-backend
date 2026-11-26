import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';
import { createNotification } from './notificationService';
import { isEitherBlocked } from './blockService';
import { checkFollowerMilestones } from './achievementService';

const FRIEND_LIMIT = 5000;
const FOLLOW_LIST_LIMIT = 20;

async function getFriendCount(userId: string, db: Prisma.TransactionClient | typeof prisma = prisma): Promise<number> {
  const following = await db.follow.findMany({ where: { followerId: userId }, select: { followingId: true } });
  const followingIds = following.map((f) => f.followingId);
  if (followingIds.length === 0) return 0;
  return db.follow.count({ where: { followerId: { in: followingIds }, followingId: userId } });
}

export async function toggleFollow(followerId: string, followingId: string) {
  if (followerId === followingId) throw new ApiError(400, 'INVALID_ACTION', 'You cannot follow yourself.');

  const target = await prisma.user.findUnique({ where: { id: followingId } });
  if (!target) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found.');

  if (await isEitherBlocked(followerId, followingId)) {
    throw new ApiError(403, 'BLOCKED', 'You cannot follow this user.');
  }

  let result: { following: boolean; shouldNotify: boolean } | null = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      result = await prisma.$transaction(async (tx) => {
        const existing = await tx.follow.findUnique({
          where: { followerId_followingId: { followerId, followingId } },
        });

        if (existing) {
          await tx.follow.delete({ where: { id: existing.id } });
          return { following: false, shouldNotify: false };
        }

        const reverseExists = await tx.follow.findUnique({
          where: { followerId_followingId: { followerId: followingId, followingId: followerId } },
        });

        if (reverseExists) {
          const [myFriends, theirFriends] = await Promise.all([
            getFriendCount(followerId, tx),
            getFriendCount(followingId, tx),
          ]);
          if (myFriends >= FRIEND_LIMIT || theirFriends >= FRIEND_LIMIT) {
            throw new ApiError(403, 'FRIEND_LIMIT_REACHED', 'Friend limit of 5,000 reached.');
          }
        }

        await tx.follow.create({ data: { followerId, followingId } });
        return { following: true, shouldNotify: true };
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });

      // Fire-and-forget: follower milestone achievements.
      if (result?.following) checkFollowerMilestones(followingId).catch(() => {});

      break;
    } catch (err: any) {
      const retryable = err?.code === 'P2034' || err?.code === 'P2002';
      if (!retryable || attempt === 3) throw err;
    }
  }

  if (!result) throw new ApiError(500, 'FOLLOW_FAILED', 'Could not update follow.');

  if (result.shouldNotify) {
    await createNotification({ userId: followingId, actorId: followerId, type: 'follow' });
  }

  return { following: result.following };
}

export async function getFollowCounts(userId: string) {
  const [followers, following] = await Promise.all([
    prisma.follow.count({ where: { followingId: userId } }),
    prisma.follow.count({ where: { followerId: userId } }),
  ]);
  const friends = await getFriendCount(userId);
  return { followers, following, friends };
}

export type FriendStatus = 'none' | 'following' | 'follow_back' | 'friends' | 'self';

export async function getFriendStatus(currentUserId: string | undefined, otherUserId: string): Promise<FriendStatus> {
  if (!currentUserId) return 'none';
  if (currentUserId === otherUserId) return 'self';
  if (await isEitherBlocked(currentUserId, otherUserId)) return 'none';

  const [iFollow, theyFollow] = await Promise.all([
    prisma.follow.findUnique({ where: { followerId_followingId: { followerId: currentUserId, followingId: otherUserId } } }),
    prisma.follow.findUnique({ where: { followerId_followingId: { followerId: otherUserId, followingId: currentUserId } } }),
  ]);

  if (iFollow && theyFollow) return 'friends';
  if (iFollow) return 'following';
  if (theyFollow) return 'follow_back';
  return 'none';
}

function listPagination(page: number, total: number, limit: number) {
  const pages = Math.ceil(total / limit);
  return { page, limit, total, pages, hasNext: page < pages, hasPrevious: page > 1 };
}

export async function getFollowUsers(
  userId: string,
  direction: 'followers' | 'following',
  page = 1,
  limit = FOLLOW_LIST_LIMIT,
  currentUserId?: string,
) {
  const safePage = Math.max(1, Number.isFinite(page) ? Math.floor(page) : 1);
  const safeLimit = Math.min(50, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : FOLLOW_LIST_LIMIT));
  const skip = (safePage - 1) * safeLimit;

  const where = direction === 'followers' ? { followingId: userId } : { followerId: userId };
  const [total, rows] = await Promise.all([
    prisma.follow.count({ where }),
    prisma.follow.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: safeLimit,
      select: {
        createdAt: true,
        follower: { select: { id: true, username: true, displayName: true, profilePictureUrl: true, isVerified: true } },
        following: { select: { id: true, username: true, displayName: true, profilePictureUrl: true, isVerified: true } },
      },
    }),
  ]);

  const users = rows.map((row) => direction === 'followers' ? row.follower : row.following);
  const userIds = users.map((user) => user.id);

  let followingIds = new Set<string>();
  let followedByIds = new Set<string>();
  let blockedIds = new Set<string>();
  if (currentUserId && userIds.length) {
    const blocked = await prisma.block.findMany({
      where: {
        OR: [
          { blockerId: currentUserId, blockedId: { in: userIds } },
          { blockerId: { in: userIds }, blockedId: currentUserId },
        ],
      },
      select: { blockerId: true, blockedId: true },
    });
    blockedIds = new Set(blocked.map((b) => b.blockerId === currentUserId ? b.blockedId : b.blockerId));
    const follows = await prisma.follow.findMany({
      where: { followerId: currentUserId, followingId: { in: userIds } },
      select: { followingId: true },
    });
    followingIds = new Set(follows.filter((f) => !blockedIds.has(f.followingId)).map((f) => f.followingId));
    // ONE extra batched query for the reverse direction: which listed users
    // follow the viewer back. The (followerId, followingId) composite unique
    // index serves it — one query per page, never per row, and never a
    // per-row GET /status fan-out from the client.
    const followedBy = await prisma.follow.findMany({
      where: { followerId: { in: userIds }, followingId: currentUserId },
      select: { followerId: true },
    });
    followedByIds = new Set(followedBy.filter((f) => !blockedIds.has(f.followerId)).map((f) => f.followerId));
  }

  return {
    users: users.map((user) => {
      // Same semantics as getFriendStatus: blocked -> 'none', own row ->
      // 'self', logged-out viewer -> 'none' for every row.
      let friendStatus: FriendStatus = 'none';
      if (currentUserId && user.id === currentUserId) {
        friendStatus = 'self';
      } else if (blockedIds.has(user.id)) {
        friendStatus = 'none';
      } else if (followingIds.has(user.id) && followedByIds.has(user.id)) {
        friendStatus = 'friends';
      } else if (followingIds.has(user.id)) {
        friendStatus = 'following';
      } else if (followedByIds.has(user.id)) {
        friendStatus = 'follow_back';
      }
      return {
        ...user,
        isFollowing: followingIds.has(user.id),
        friendStatus,
      };
    }),
    pagination: listPagination(safePage, total, safeLimit),
  };
}
