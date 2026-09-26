import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';
import { getFriendStatus } from './followService';
import { createNotification } from './notificationService';

function toAuthorDTO(user: any) {
  return { id: user.id, username: user.username, displayName: user.displayName, profilePictureUrl: user.profilePictureUrl, isVerified: user.isVerified ?? false };
}

async function toPostDTO(post: any, currentUserId?: string): Promise<any> {
  const myLike = currentUserId ? post.likes?.find((l: any) => l.userId === currentUserId) : null;
  const friendStatus = await getFriendStatus(currentUserId, post.userId);
  const reactionCounts: Record<string, number> = {};
  for (const like of post.likes || []) reactionCounts[like.type] = (reactionCounts[like.type] || 0) + 1;

  return {
    id: post.id,
    content: post.content,
    imageUrl: post.imageUrl,
    backgroundStyle: post.backgroundStyle,
    location: post.location,
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

export async function createPost(userId: string, content: string, imageUrl?: string, visibility: 'public' | 'private' = 'public', taggedUserIds: string[] = [], commentAudience: 'everyone' | 'followers' | 'only_me' = 'everyone', backgroundStyle?: 'sunset' | 'ocean' | 'violet' | 'mint' | 'peach' | 'night' | 'rose' | 'sky', location?: string) {
  const limitedTaggedUserIds = [...new Set(taggedUserIds)].slice(0, 2);
  const post = await prisma.post.create({
    data: { userId, content, imageUrl, visibility, commentAudience, backgroundStyle: imageUrl ? undefined : backgroundStyle, location, tags: { create: limitedTaggedUserIds.map((id) => ({ userId: id })) } },
    include: includeShape,
  });

  // Notify users who were tagged in the post. The existing comment_mention
  // notification type is reused for backward-compatible DB schema; a missing
  // commentId means this notification is a post tag.
  for (const taggedId of limitedTaggedUserIds) {
    if (taggedId === userId) continue;
    await createNotification({
      userId: taggedId,
      actorId: userId,
      type: 'comment_mention',
      postId: post.id,
    });
  }

  return toPostDTO(post, userId);
}

export async function sharePost(userId: string, originalPostId: string, content: string) {
  const original = await prisma.post.findUnique({ where: { id: originalPostId } });
  if (!original) throw new ApiError(404, 'POST_NOT_FOUND', 'Post not found.');
  if (original.visibility === 'private' && original.userId !== userId) throw new ApiError(403, 'FORBIDDEN', 'You cannot share this post.');

  const post = await prisma.post.create({ data: { userId, content, originalPostId }, include: includeShape });
  await createNotification({ userId: original.userId, actorId: userId, type: 'post_share', postId: post.id });
  return toPostDTO(post, userId);
}

const WEIGHTS = { like: 3, comment: 5, share: 4, countryMatch: 40, affinityPerPastLike: 8, affinityCap: 80, recencyBase: 200 };

export async function getFeed(currentUserId?: string, limit = 20, offset = 0) {
  const [hiddenPostIds, blockedRows] = currentUserId
    ? await Promise.all([
        prisma.hiddenPost.findMany({ where: { userId: currentUserId }, select: { postId: true } }),
        prisma.block.findMany({ where: { OR: [{ blockerId: currentUserId }, { blockedId: currentUserId }] }, select: { blockerId: true, blockedId: true } }),
      ])
    : [[], []];

  const hiddenIds = hiddenPostIds.map((h: any) => h.postId);
  const blockedIds = new Set<string>();
  for (const b of blockedRows as any[]) blockedIds.add(b.blockerId === currentUserId ? b.blockedId : b.blockerId);

  // The ranking algorithm needs enough candidates to cover the requested page.
  // This avoids the old fixed 200-item ceiling breaking pagination after page 10.
  const safeLimit = Math.min(Math.max(limit, 1), 50);
  const safeOffset = Math.max(offset, 0);
  const poolSize = safeOffset + safeLimit + 40;

  const followingIds = currentUserId
    ? new Set((await prisma.follow.findMany({ where: { followerId: currentUserId }, select: { followingId: true } })).map((f) => f.followingId))
    : new Set<string>();

  const rawCandidatePosts = await prisma.post.findMany({
    where: {
      visibility: 'public',
      ...(hiddenIds.length ? { id: { notIn: hiddenIds } } : {}),
      ...(blockedIds.size ? { userId: { notIn: [...blockedIds] } } : {}),
    },
    take: poolSize,
    orderBy: { createdAt: 'desc' },
    include: includeShape,
  });

  const candidatePosts = rawCandidatePosts.filter((p) => !p.user.isPrivate || p.userId === currentUserId || followingIds.has(p.userId));

  let currentUserCountry: string | null = null;
  const affinityMap = new Map<string, number>();
  if (currentUserId) {
    const me = await prisma.user.findUnique({ where: { id: currentUserId }, select: { country: true } });
    currentUserCountry = me?.country ?? null;
    const pastLikes = await prisma.like.findMany({ where: { userId: currentUserId }, select: { post: { select: { userId: true } } }, take: 500, orderBy: { createdAt: 'desc' } });
    for (const l of pastLikes) affinityMap.set(l.post.userId, (affinityMap.get(l.post.userId) || 0) + 1);
  }

  const now = Date.now();
  const scored = candidatePosts.map((post) => {
    const hoursOld = (now - new Date(post.createdAt).getTime()) / 3600000;
    const recencyScore = WEIGHTS.recencyBase / (hoursOld + 2);
    const engagementScore = post._count.likes * WEIGHTS.like + post._count.comments * WEIGHTS.comment + post._count.reposts * WEIGHTS.share;
    const countryBoost = currentUserCountry && post.user.country && currentUserCountry === post.user.country ? WEIGHTS.countryMatch : 0;
    const affinityBoost = Math.min((affinityMap.get(post.userId) || 0) * WEIGHTS.affinityPerPastLike, WEIGHTS.affinityCap);
    return { post, score: recencyScore + engagementScore + countryBoost + affinityBoost };
  });

  scored.sort((a, b) => b.score - a.score);
  const pageSlice = scored.slice(safeOffset, safeOffset + safeLimit).map((s) => s.post);
  const hasMore = scored.length > safeOffset + safeLimit;
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
  const posts = await prisma.post.findMany({ where: isOwner ? { userId: user.id } : { userId: user.id, visibility: 'public' }, orderBy: { createdAt: 'desc' }, include: includeShape });
  return Promise.all(posts.map((p) => toPostDTO(p, currentUserId)));
}

export async function getPostById(postId: string, currentUserId?: string) {
  const post = await prisma.post.findUnique({ where: { id: postId }, include: includeShape });
  if (!post) throw new ApiError(404, 'POST_NOT_FOUND', 'Post not found.');
  if (post.user.isPrivate && post.userId !== currentUserId) {
    const friendStatus = await getFriendStatus(currentUserId, post.userId);
    if (friendStatus !== 'following' && friendStatus !== 'friends') throw new ApiError(403, 'PRIVATE_ACCOUNT', 'This account is private.');
  }
  if (post.visibility === 'private' && post.userId !== currentUserId) throw new ApiError(404, 'POST_NOT_FOUND', 'Post not found.');
  return toPostDTO(post, currentUserId);
}

export async function updatePost(userId: string, postId: string, data: { content?: string; commentAudience?: 'everyone' | 'followers' | 'only_me' }) {
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
  const existing = await prisma.report.findUnique({ where: { postId_reporterId: { postId, reporterId: userId } } });
  if (existing) throw new ApiError(400, 'ALREADY_REPORTED', 'You have already reported this post.');
  await prisma.report.create({ data: { postId, reporterId: userId, reason: reason as any, details } });
  return { reported: true };
}

export async function hidePost(userId: string, postId: string) {
  const post = await prisma.post.findUnique({ where: { id: postId } });
  if (!post) throw new ApiError(404, 'POST_NOT_FOUND', 'Post not found.');
  await prisma.hiddenPost.upsert({ where: { userId_postId: { userId, postId } }, update: {}, create: { userId, postId } });
  return { hidden: true };
}
