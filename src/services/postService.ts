import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';
import { getFriendStatus } from './followService';
import { createNotification } from './notificationService';
import { moderatePost } from './moderationService';
import { awardAchievement } from './achievementService';

function toAuthorDTO(user: any) {
  if (!user) return { id: '', username: 'deleted', displayName: 'Deleted User', profilePictureUrl: null, isVerified: false };
  return { id: user.id, username: user.username, displayName: typeof user.displayName === 'string' ? user.displayName.trim() : user.displayName, profilePictureUrl: user.profilePictureUrl, isVerified: user.isVerified ?? false };
}

// Batch-load permanent share codes (generated once on first share, reused forever)
// for a list of target ids. Returns a map targetId -> code.
async function getShareCodeMap(
  targetType: 'post' | 'reel' | 'profile',
  targetIds: string[]
): Promise<Map<string, string>> {
  if (!targetIds.length) return new Map();
  const rows = await prisma.shareLink
    .findMany({
      where: { targetType, targetId: { in: [...new Set(targetIds)] } },
      select: { targetId: true, code: true },
    })
    .catch(() => [] as Array<{ targetId: string; code: string }>);
  return new Map(rows.map((r) => [r.targetId, r.code]));
}

export async function toPostDTO(post: any, currentUserId?: string, shareCodeMap?: Map<string, string>): Promise<any> {
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
    pinnedAt: post.pinnedAt ?? null,
    isPinned: !!post.pinnedAt,
    likeCount: post._count?.likes ?? 0,
    commentCount: post._count?.comments ?? 0,
    shareCount: post._count?.reposts ?? 0,
    reactionCounts,
    myReaction: myLike ? myLike.type : null,
    author: toAuthorDTO(post.user),
    friendStatus,
    taggedUsers: post.tags?.map((t: any) => toAuthorDTO(t.user)) ?? [],
    originalPost: post.originalPost ? await toPostDTO(post.originalPost, currentUserId, shareCodeMap) : null,
    shareCode: shareCodeMap?.get(post.id) ?? null,
  };
}

export const includeShape = {
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

  awardAchievement(userId, 'first_post').catch(() => {});
  if (content?.trim()) {
    setImmediate(() => { moderatePost(post.id).catch((err) => console.error('[moderation] background post check failed', err)); });
  }
  // AI agents comment on new public posts (background, human-like)
  if (content?.trim() && visibility === 'public') {
    setImmediate(async () => {
      try {
        const { triggerAIComments } = await import('./aiAgentService');
        const author = await prisma.user.findUnique({ where: { id: userId }, select: { displayName: true, username: true } }).catch(() => null);
        triggerAIComments(post.id, content, author?.displayName || author?.username || 'someone', userId, post.createdAt);
      } catch {}
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

const WEIGHTS = { like: 3, comment: 5, share: 4, countryMatch: 40, cityMatch: 70, followingBonus: 50, affinityPerPastLike: 15, affinityPerComment: 12, affinityPerWatchSec: 0.5, affinityCap: 100, recencyBase: 400, verifiedBonus: 60 };

/**
 * Adaptive home-feed content mix: how much of the mixed feed should be reels
 * vs posts, based on the user's actual consumption over the last 7 days.
 * Watch time is the strongest signal; likes/comments add intent weight.
 * Returns reelRatio 0..1 (0.5 = neutral, used for new users with no history).
 */
export async function getContentMix(userId: string) {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600000);
  try {
    const [reelWatch, postWatch, reelLikes, postLikes] = await Promise.all([
      prisma.$queryRawUnsafe<Array<{ total: bigint }>>(
        `SELECT COALESCE(SUM(watch_sec), 0) as total FROM reel_views WHERE viewer_id = ? AND created_at >= ?`,
        userId, sevenDaysAgo
      ).catch(() => [{ total: BigInt(0) }]),
      prisma.$queryRawUnsafe<Array<{ total: bigint }>>(
        `SELECT COALESCE(SUM(watch_sec), 0) as total FROM post_views WHERE viewer_id = ? AND created_at >= ?`,
        userId, sevenDaysAgo
      ).catch(() => [{ total: BigInt(0) }]),
      prisma.reelLike.count({ where: { userId, createdAt: { gte: sevenDaysAgo } } }).catch(() => 0),
      prisma.like.count({ where: { userId, createdAt: { gte: sevenDaysAgo } } }).catch(() => 0),
    ]);
    const reelScore = Number(reelWatch[0]?.total || 0) + reelLikes * 30;
    const postScore = Number(postWatch[0]?.total || 0) + postLikes * 30;
    const total = reelScore + postScore;
    const reelRatio = total > 0 ? reelScore / total : 0.5;
    // Clamp between 0.2 and 0.8 so neither type disappears entirely
    return { reelRatio: Math.min(0.8, Math.max(0.2, reelRatio)) };
  } catch {
    return { reelRatio: 0.5 };
  }
}

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

  const candidatePosts = rawCandidatePosts.filter((p) => !p.user?.isPrivate || p.userId === currentUserId || followingIds.has(p.userId));

  let currentUserCountry: string | null = null;
  let currentUserCity: string | null = null;
  const affinityMap = new Map<string, number>();
  if (currentUserId) {
    const me = await prisma.user.findUnique({ where: { id: currentUserId }, select: { country: true, city: true } });
    currentUserCountry = me?.country ?? null;
    currentUserCity = me?.city ?? null;
    // Affinity from likes (weight 1x)
    const pastLikes = await prisma.like.findMany({ where: { userId: currentUserId }, select: { post: { select: { userId: true } } }, take: 200, orderBy: { createdAt: 'desc' } }).catch(() => []);
    for (const l of pastLikes) affinityMap.set(l.post.userId, (affinityMap.get(l.post.userId) || 0) + WEIGHTS.affinityPerPastLike);
    // Affinity from comments (weight 1.5x - commenting shows stronger interest)
    const pastComments = await prisma.comment.findMany({ where: { userId: currentUserId }, select: { post: { select: { userId: true } } }, take: 200, orderBy: { createdAt: 'desc' } }).catch(() => []);
    for (const cm of pastComments) {
      if (cm.post?.userId) affinityMap.set(cm.post.userId, (affinityMap.get(cm.post.userId) || 0) + WEIGHTS.affinityPerComment);
    }
    // Affinity from watch time (dwell time on posts)
    try {
      const watchRows = await prisma.$queryRawUnsafe<Array<{ user_id: string; total_sec: number }>>(
        `SELECT p.user_id, SUM(pv.watch_sec) as total_sec FROM post_views pv JOIN posts p ON p.id = pv.post_id WHERE pv.viewer_id = ? GROUP BY p.user_id`,
        currentUserId
      );
      for (const w of watchRows) {
        const secs = Number(w.total_sec) || 0;
        if (secs > 0) affinityMap.set(w.user_id, (affinityMap.get(w.user_id) || 0) + secs * WEIGHTS.affinityPerWatchSec);
      }
    } catch {}
  }

  // FIX 3 (2026-10-15): posts this user already viewed (for seen-suppression on refresh)
  const seenPostIds = new Set<string>();
  if (currentUserId) {
    try {
      const seenRows = await prisma.postView.findMany({
        where: { viewerId: currentUserId },
        select: { postId: true },
        orderBy: { createdAt: 'desc' },
        take: 500,
      });
      for (const r of seenRows) seenPostIds.add(r.postId);
    } catch {}
  }

  const now = Date.now();
  const isFirstPage = safeOffset === 0;
  const scored = candidatePosts.map((post) => {
    const hoursOld = (now - new Date(post.createdAt).getTime()) / 3600000;
    const recencyScore = WEIGHTS.recencyBase / (hoursOld + 2);
    const rawEngagement = post._count.likes * WEIGHTS.like + post._count.comments * WEIGHTS.comment + post._count.reposts * WEIGHTS.share;
    // FIX 1 (2026-10-15): engagement time-decay — value halves every ~24h so old viral
    // posts sink and fresh posts can surface instead of being buried forever.
    const engagementScore = rawEngagement / (1 + hoursOld / 24);
    // Location: city match stronger than country
    let locationBoost = 0;
    if (currentUserCity && (post.user as any).city && currentUserCity === (post.user as any).city) {
      locationBoost = WEIGHTS.cityMatch;
    } else if (currentUserCountry && post.user.country && currentUserCountry === post.user.country) {
      locationBoost = WEIGHTS.countryMatch;
    }
    // Following bonus
    const followingBonus = followingIds.has(post.userId) ? WEIGHTS.followingBonus : 0;
    // Affinity (capped)
    const affinityBoost = Math.min(affinityMap.get(post.userId) || 0, WEIGHTS.affinityCap);
    // Verified author boost (Blue Tick perk: better reach)
    // FIX 2 (2026-10-15): verified boost decays with age too — the Blue Tick reach perk
    // stays strong for fresh posts but no longer keeps month-old verified posts immortal.
    const verifiedBoost = (post.user as any)?.isVerified ? WEIGHTS.verifiedBonus / (1 + hoursOld / 24) : 0;
    const baseScore = recencyScore + engagementScore + locationBoost + followingBonus + affinityBoost + verifiedBoost;
    // FIX 3 (2026-10-15): seen posts sink on first-page refresh (IG-style), plus a small
    // FIX 3 (2026-10-15, strengthened 2026-10-17): seen posts sink HARD on first-page
    // refresh (IG-style). User complained 2026-10-17: "wahi old boring same posts".
    // 0.05 penalty ensures seen posts almost never resurface on page 1.
    // Only applied on the first page so offset pagination stays stable.
    const seenFactor = isFirstPage && seenPostIds.has(post.id) ? 0.05 : 1;
    const jitter = isFirstPage ? 1 + (Math.random() - 0.5) * 0.08 : 1;
    return { post, hoursOld, score: baseScore * seenFactor * jitter };
  });

  scored.sort((a, b) => b.score - a.score);

  // FIX 4 (2026-10-15): exploration slot — guarantee at least 2 fresh (<3h) posts in the
  // top 5 on the first page, so brand-new posts always get a chance to be discovered.
  if (isFirstPage) {
    // HIDE SEEN POSTS (user-ordered 2026-10-17): "jo post dekh liya wo top par
    // dobara na aaye". Remove seen posts from page 1 entirely (keep them for
    // deeper pages). Only if unseen posts exist to fill the page.
    if (currentUserId && seenPostIds.size > 0) {
      const unseen = scored.filter((x) => !seenPostIds.has(x.post.id));
      // Only filter if we have enough unseen to fill the page
      if (unseen.length >= safeLimit) {
        scored.length = 0;
        scored.push(...unseen);
      }
    }

    const freshInTop5 = scored.slice(0, 5).filter((x) => x.hoursOld < 3).length;
    const need = Math.max(0, 2 - freshInTop5);
    if (need > 0) {
      const picked: typeof scored = [];
      const rest = scored.filter((x, i) => {
        if (i >= 5 && x.hoursOld < 3 && picked.length < need) { picked.push(x); return false; }
        return true;
      });
      picked.forEach((item, k) => rest.splice(k === 0 ? 1 : 3, 0, item));
      scored.length = 0;
      scored.push(...rest);
    }

    // OWN NEW POST FIRST (user-ordered 2026-10-17): when you create a post,
    // you see it at the very top the 1st time. After you've seen it (reload),
    // normal ranking applies. Only for posts <1h old.
    if (currentUserId) {
      const ownFreshUnseen = scored.filter((x) => {
        return x.post.userId === currentUserId && x.hoursOld < 1 && !seenPostIds.has(x.post.id);
      });
      if (ownFreshUnseen.length > 0) {
        ownFreshUnseen.sort((a, b) => a.hoursOld - b.hoursOld);
        const top = ownFreshUnseen[0];
        const idx = scored.indexOf(top);
        if (idx > 0) {
          scored.splice(idx, 1);
          scored.unshift(top);
        }
      }
    }

    // ANTI-BOREDOM DIVERSITY (user-ordered 2026-10-17): never show 2 posts
    // from the same author back-to-back on the first page.
    const diversified: typeof scored = [];
    const remaining = [...scored];
    while (remaining.length > 0) {
      let pickIdx = 0;
      if (diversified.length > 0) {
        const lastAuthor = diversified[diversified.length - 1].post.userId;
        pickIdx = remaining.findIndex((x) => x.post.userId !== lastAuthor);
        if (pickIdx === -1) pickIdx = 0;
      }
      diversified.push(remaining[pickIdx]);
      remaining.splice(pickIdx, 1);
    }
    scored.length = 0;
    scored.push(...diversified);
  }
  const pageSlice = scored.slice(safeOffset, safeOffset + safeLimit).map((s) => s.post);
  const hasMore = scored.length > safeOffset + safeLimit;
  const shareCodeMap = await getShareCodeMap('post', pageSlice.map((p) => p.id));
  const posts = await Promise.all(pageSlice.map((p) => toPostDTO(p, currentUserId, shareCodeMap)));
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
  const posts = await prisma.post.findMany({ where: isOwner ? { userId: user.id } : { userId: user.id, visibility: 'public' }, orderBy: [{ pinnedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }], include: includeShape });
  const shareCodeMap = await getShareCodeMap('post', posts.map((p) => p.id));
  return Promise.all(posts.map((p) => toPostDTO(p, currentUserId, shareCodeMap)));
}

export async function togglePinPost(userId: string, postId: string) {
  const post = await prisma.post.findUnique({ where: { id: postId } });
  if (!post) throw new ApiError(404, 'POST_NOT_FOUND', 'Post not found.');
  if (post.userId !== userId) throw new ApiError(403, 'FORBIDDEN', 'Not your post.');
  if (!post.pinnedAt) {
    const pinnedCount = await prisma.post.count({ where: { userId, pinnedAt: { not: null } } });
    if (pinnedCount >= 3) throw new ApiError(400, 'PIN_LIMIT', 'You can pin up to 3 posts.');
  }
  const updated = await prisma.post.update({
    where: { id: postId },
    data: { pinnedAt: post.pinnedAt ? null : new Date() },
    include: includeShape,
  });
  return toPostDTO(updated, userId);
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
