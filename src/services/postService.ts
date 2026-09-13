import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';
import { getFriendStatus } from './followService';
import { createNotification } from './notificationService';

function toAuthorDTO(user: any) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    profilePictureUrl: user.profilePictureUrl,
  };
}

async function toPostDTO(post: any, currentUserId?: string): Promise<any> {
  const myLike = currentUserId ? post.likes?.find((l: any) => l.userId === currentUserId) : null;
  const friendStatus = await getFriendStatus(currentUserId, post.userId);

  const reactionCounts: Record<string, number> = {};
  for (const like of post.likes || []) {
    reactionCounts[like.type] = (reactionCounts[like.type] || 0) + 1;
  }

  return {
    id: post.id,
    content: post.content,
    imageUrl: post.imageUrl,
    visibility: post.visibility,
    commentAudience: post.commentAudience,
    createdAt: post.createdAt,
    likeCount: post._count?.likes ?? 0,
    commentCount: post._count?.comments ?? 0,
    shareCount: post._count?.reposts ?? 0,
    reactionCounts,
    myReaction: myLike ? myLike.type : null,
    author: toAuthorDTO(post.user),
    friendStatus,
    taggedUsers: post.tags?.map((t: any) => toAuthorDTO(t.user)) ?? [],
    originalPost: post.originalPost ? await toPostDTO(post.originalPost, currentUserId) : null,
  };
}

// commentCount only counts top-level comments (parentCommentId: null) —
// replies are intentionally excluded from the number shown on a post.
const includeShape = {
  user: true,
  _count: { select: { likes: true, comments: { where: { parentCommentId: null } }, reposts: true } },
  likes: true,
  tags: { include: { user: true } },
  originalPost: {
    include: {
      user: true,
      _count: { select: { likes: true, comments: { where: { parentCommentId: null } }, reposts: true } },
      likes: true,
      tags: { include: { user: true } },
    },
  },
};

export async function createPost(
  userId: string,
  content: string,
  imageUrl?: string,
  visibility: 'public' | 'private' = 'public',
  taggedUserIds: string[] = []
) {
  const post = await prisma.post.create({
    data: {
      userId,
      content,
      imageUrl,
      visibility,
      tags: { create: taggedUserIds.slice(0, 2).map((id) => ({ userId: id })) },
    },
    include: includeShape,
  });
  return toPostDTO(post, userId);
}

export async function sharePost(userId: string, originalPostId: string, content: string) {
  const original = await prisma.post.findUnique({ where: { id: originalPostId } });
  if (!original) throw new ApiError(404, 'POST_NOT_FOUND', 'Post not found.');
  const post = await prisma.post.create({
    data: { userId, content, originalPostId },
    include: includeShape,
  });

  await createNotification({
    userId: original.userId,
    actorId: userId,
    type: 'post_share',
    postId: post.id,
  });

  return toPostDTO(post, userId);
}

const WEIGHTS = {
  like: 3,
  comment: 5,
  share: 4,
  countryMatch: 40,
  affinityPerPastLike: 8,
  affinityCap: 80,
  recencyBase: 200,
};

export async function getFeed(currentUserId?: string, limit = 20, offset = 0) {
  const hiddenPostIds = currentUserId
    ? (
        await prisma.hiddenPost.findMany({
          where: { userId: currentUserId },
          select: { postId: true },
        })
      ).map((h) => h.postId)
    : [];

  // Candidate pool needs to comfortably cover however deep the requester
  // has paginated, plus headroom for ranking to still be meaningful.
  const poolSize = Math.max(200, offset + limit + 40);

  const followingIds = currentUserId
    ? new Set(
        (await prisma.follow.findMany({ where: { followerId: currentUserId }, select: { followingId: true } })).map(
          (f) => f.followingId
        )
      )
    : new Set<string>();

  const rawCandidatePosts = await prisma.post.findMany({
    where: {
      visibility: 'public',
      ...(hiddenPostIds.length ? { id: { notIn: hiddenPostIds } } : {}),
    },
    take: poolSize,
    orderBy: { createdAt: 'desc' },
    include: includeShape,
  });

  const candidatePosts = rawCandidatePosts.filter(
    (p) => !p.user.isPrivate || p.userId === currentUserId || followingIds.has(p.userId)
  );

  let currentUserCountry: string | null = null;
  const affinityMap = new Map<string, number>();

  if (currentUserId) {
    const me = await prisma.user.findUnique({ where: { id: currentUserId }, select: { country: true } });
    currentUserCountry = me?.country ?? null;

    const pastLikes = await prisma.like.findMany({
      where: { userId: currentUserId },
      select: { post: { select: { userId: true } } },
      take: 500,
      orderBy: { createdAt: 'desc' },
    });
    for (const l of pastLikes) {
      const authorId = l.post.userId;
      affinityMap.set(authorId, (affinityMap.get(authorId) || 0) + 1);
    }
  }

  const now = Date.now();
  const scored = candidatePosts.map((post) => {
    const hoursOld = (now - new Date(post.createdAt).getTime()) / 3600000;
    const recencyScore = WEIGHTS.recencyBase / (hoursOld + 2);

    const likeCount = post._count.likes;
    const commentCount = post._count.comments;
    const shareCount = post._count.reposts;
    const engagementScore = likeCount * WEIGHTS.like + commentCount * WEIGHTS.comment + shareCount * WEIGHTS.share;

    const countryBoost =
      currentUserCountry && post.user.country && currentUserCountry === post.user.country ? WEIGHTS.countryMatch : 0;

    const affinityBoost = Math.min(
      (affinityMap.get(post.userId) || 0) * WEIGHTS.affinityPerPastLike,
      WEIGHTS.affinityCap
    );

    const score = recencyScore + engagementScore + countryBoost + affinityBoost;
    return { post, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const pageSlice = scored.slice(offset, offset + limit).map((s) => s.post);
  const hasMore = scored.length > offset + limit;

  const posts = await Promise.all(pageSlice.map((p) => toPostDTO(p, currentUserId)));
  return { posts, hasMore };
}

export async function getPostsByUsername(username: string, currentUserId?: string) {
  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found.');
  const isOwner = currentUserId === user.id;

  if (user.isPrivate && !isOwner) {
    const friendStatus = await getFriendStatus(currentUserId, user.id);
    if (friendStatus !== 'following' && friendStatus !== 'friends') return [];
  }

  const posts = await prisma.post.findMany({
    where: isOwner ? { userId: user.id } : { userId: user.id, visibility: 'public' },
    orderBy: { createdAt: 'desc' },
    include: includeShape,
  });
  return Promise.all(posts.map((p) => toPostDTO(p, currentUserId)));
}

export async function getPostById(postId: string, currentUserId?: string) {
  const post = await prisma.post.findUnique({ where: { id: postId }, include: includeShape });
  if (!post) throw new ApiError(404, 'POST_NOT_FOUND', 'Post not found.');

  if (post.user.isPrivate && post.userId !== currentUserId) {
    const friendStatus = await getFriendStatus(currentUserId, post.userId);
    if (friendStatus !== 'following' && friendStatus !== 'friends') {
      throw new ApiError(403, 'PRIVATE_ACCOUNT', 'This account is private.');
    }
  }

  return toPostDTO(post, currentUserId);
}

export async function updatePost(
  userId: string,
  postId: string,
  data: { content?: string; commentAudience?: 'everyone' | 'followers' | 'only_me' }
) {
  const post = await prisma.post.findUnique({ where: { id: postId } });
  if (!post) throw new ApiError(404, 'POST_NOT_FOUND', 'Post not found.');
  if (post.userId !== userId) throw new ApiError(403, 'FORBIDDEN', 'Not your post.');
  const updated = await prisma.post.update({ where: { id: postId }, data, include: includeShape });
  return toPostDTO(updated, userId);
}

export async function deletePost(userId: string, postId: string) {
  const post = await prisma.post.findUnique({ where: { id: postId } });
  if (!post) throw new ApiError(404, 'POST_NOT_FOUND', 'Post not found.');
  if (post.userId !== userId) throw new ApiError(403, 'FORBIDDEN', 'Not your post.');
  await prisma.post.delete({ where: { id: postId } });
}

export async function reportPost(userId: string, postId: string, reason: string, details?: string) {
  const post = await prisma.post.findUnique({ where: { id: postId } });
  if (!post) throw new ApiError(404, 'POST_NOT_FOUND', 'Post not found.');

  const existing = await prisma.report.findUnique({
    where: { postId_reporterId: { postId, reporterId: userId } },
  });
  if (existing) throw new ApiError(400, 'ALREADY_REPORTED', 'You have already reported this post.');

  await prisma.report.create({
    data: { postId, reporterId: userId, reason: reason as any, details },
  });
  return { reported: true };
}

export async function hidePost(userId: string, postId: string) {
  const post = await prisma.post.findUnique({ where: { id: postId } });
  if (!post) throw new ApiError(404, 'POST_NOT_FOUND', 'Post not found.');

  await prisma.hiddenPost.upsert({
    where: { userId_postId: { userId, postId } },
    update: {},
    create: { userId, postId },
  });
  return { hidden: true };
}
