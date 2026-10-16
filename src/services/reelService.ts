import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';
import { env } from '../config/env';
import { deleteFromR2 } from '../config/r2';
import { getFriendStatus } from './followService';
import { isEitherBlocked } from './blockService';
import { createNotification } from './notificationService';
import { awardAchievement } from './achievementService';
import { moderateReel } from './moderationService';

const authorSelect = { id: true, username: true, displayName: true, profilePictureUrl: true, isVerified: true };

export async function addReelComment(userId: string, reelId: string, content: string, parentCommentId?: string) {
  const reel = await prisma.reel.findUnique({ where: { id: reelId } });
  if (!reel) throw new ApiError(404, 'REEL_NOT_FOUND', 'Reel not found.');
  if (await isEitherBlocked(userId, reel.userId)) throw new ApiError(403, 'BLOCKED', 'Cannot comment on this reel.');
  const trimmed = content.trim();
  if (!trimmed) throw new ApiError(400, 'EMPTY_COMMENT', 'Comment cannot be empty.');
  if (parentCommentId) {
    const parent = await prisma.reelComment.findUnique({ where: { id: parentCommentId }, select: { id: true, reelId: true } });
    if (!parent || parent.reelId !== reelId) throw new ApiError(400, 'INVALID_PARENT', 'Reply target is invalid.');
  }
  const created = await prisma.reelComment.create({ data: { reelId, userId, parentCommentId, content: trimmed }, include: { user: { select: authorSelect } } });
  try {
    if (parentCommentId) {
      const parentAuthor = await prisma.reelComment.findUnique({ where: { id: parentCommentId }, select: { userId: true } });
      if (parentAuthor) await createNotification({ userId: parentAuthor.userId, actorId: userId, type: 'reel_reply', reelId, commentId: parentCommentId });
    } else {
      await createNotification({ userId: reel.userId, actorId: userId, type: 'reel_comment', reelId });
    }
  } catch (err) {
    console.error('[notify] reel comment notification failed', err);
  }
  return created;
}

const REEL_COMMENT_PAGE_SIZE = 20;

function encodeReelCommentCursor(createdAt: Date, id: string) {
  return Buffer.from(JSON.stringify({ createdAt: createdAt.toISOString(), id }), 'utf8').toString('base64url');
}

function decodeReelCommentCursor(cursor?: string) {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed?.createdAt !== 'string' || typeof parsed?.id !== 'string') return null;
    const createdAt = new Date(parsed.createdAt);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id: parsed.id };
  } catch {
    return null;
  }
}

export async function getReelComments(reelId: string, currentUserId: string, cursor?: string, limit = REEL_COMMENT_PAGE_SIZE) {
  const safeLimit = Math.min(Math.max(limit, 1), REEL_COMMENT_PAGE_SIZE);
  const decodedCursor = decodeReelCommentCursor(cursor);
  if (cursor && !decodedCursor) throw new ApiError(400, 'INVALID_CURSOR', 'Invalid comment pagination cursor.');

  const rootWhere: any = { reelId, parentCommentId: null };
  if (decodedCursor) {
    rootWhere.OR = [
      { createdAt: { lt: decodedCursor.createdAt } },
      { createdAt: decodedCursor.createdAt, id: { lt: decodedCursor.id } },
    ];
  }

  const roots = await prisma.reelComment.findMany({
    where: rootWhere,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: safeLimit + 1,
    include: {
      user: { select: authorSelect },
      reactions: { select: { type: true, userId: true } },
    },
  });

  const hasMore = roots.length > safeLimit;
  const pageRoots = hasMore ? roots.slice(0, safeLimit) : roots;
  const rootIds = pageRoots.map((row) => row.id);

  const replies = rootIds.length
    ? await prisma.reelComment.findMany({
        where: { reelId, parentCommentId: { in: rootIds } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: {
          user: { select: authorSelect },
          reactions: { select: { type: true, userId: true } },
        },
      })
    : [];

  const nodes = new Map<string, any>();
  for (const row of [...pageRoots, ...replies]) {
    nodes.set(row.id, {
      id: row.id,
      reelId: row.reelId,
      content: row.content,
      createdAt: row.createdAt,
      author: row.user,
      reactionCount: row.reactions.length,
      myReaction: row.reactions.find((r) => r.userId === currentUserId)?.type ?? null,
      replies: [],
    });
  }

  for (const row of replies) {
    const parent = nodes.get(row.parentCommentId!);
    if (parent) parent.replies.push(nodes.get(row.id));
  }

  const result = pageRoots.map((row) => nodes.get(row.id));
  const last = pageRoots[pageRoots.length - 1];

  return {
    comments: result,
    pagination: {
      hasMore,
      nextCursor: hasMore && last ? encodeReelCommentCursor(last.createdAt, last.id) : null,
    },
  };
}

export async function toggleReelCommentReaction(userId: string, commentId: string, type: string) {
  const allowed = new Set(['like', 'love', 'haha', 'wow', 'sad', 'angry']);
  if (!allowed.has(type)) throw new ApiError(400, 'INVALID_REACTION', 'Invalid reaction type.');
  const comment = await prisma.reelComment.findUnique({ where: { id: commentId }, include: { reel: true } });
  if (!comment) throw new ApiError(404, 'COMMENT_NOT_FOUND', 'Comment not found.');
  if (await isEitherBlocked(userId, comment.reel.userId)) throw new ApiError(403, 'BLOCKED', 'Cannot react to this comment.');
  return prisma.$transaction(async (tx) => {
    const existing = await tx.reelCommentReaction.findUnique({ where: { userId_commentId: { userId, commentId } } });
    if (existing) {
      if (existing.type === type) {
        await tx.reelCommentReaction.delete({ where: { id: existing.id } });
        return { reaction: null };
      }
      const updated = await tx.reelCommentReaction.update({ where: { id: existing.id }, data: { type: type as any } });
      return { reaction: updated.type };
    }
    const created = await tx.reelCommentReaction.create({ data: { userId, commentId, type: type as any } });
    return { reaction: created.type };
  }, { isolationLevel: 'Serializable' });
}

export async function deleteReelComment(userId: string, commentId: string) {
  const comment = await prisma.reelComment.findUnique({ where: { id: commentId }, include: { reel: true } });
  if (!comment) throw new ApiError(404, 'COMMENT_NOT_FOUND', 'Comment not found.');
  if (comment.userId !== userId && comment.reel.userId !== userId) throw new ApiError(403, 'FORBIDDEN', 'You cannot delete this comment.');
  await prisma.reelComment.delete({ where: { id: commentId } });
  return { deleted: true };
}

export async function getReelsConfig() { return { enabled: env.reelsEnabled, maxDurationSec: env.reelMaxDurationSec, dailyLimit: env.reelDailyLimit }; }

export async function createReel(userId: string, data: { videoUrl: string; caption?: string; durationSec: number; thumbnailUrl?: string; category?: string }) {
  if (!env.reelsEnabled) throw new ApiError(403, 'REELS_DISABLED', 'Reels are currently unavailable.');
  if (!Number.isInteger(data.durationSec) || data.durationSec <= 0 || data.durationSec > env.reelMaxDurationSec) throw new ApiError(400, 'INVALID_DURATION', `Reel duration must be between 1 and ${env.reelMaxDurationSec} seconds.`);
  return prisma.$transaction(async (tx) => {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentCount = await tx.reel.count({ where: { userId, createdAt: { gt: oneDayAgo } } });
    if (recentCount >= env.reelDailyLimit) throw new ApiError(429, 'DAILY_LIMIT_REACHED', `You can only post ${env.reelDailyLimit} reel${env.reelDailyLimit === 1 ? '' : 's'} per day. Try again later.`);
    const reel = await tx.reel.create({ data: { userId, videoUrl: data.videoUrl, caption: data.caption, durationSec: data.durationSec, thumbnailUrl: data.thumbnailUrl, category: data.category || null } });
    return reel;
  }, { isolationLevel: 'Serializable' }).then((reel) => {
    awardAchievement(userId, 'first_reel').catch(() => {});
    // Background caption moderation (after commit)
    if (data.caption?.trim()) {
      setImmediate(() => { moderateReel(reel.id).catch((err) => console.error('[moderation] background reel check failed', err)); });
    }
    return reel;
  });
}

export async function getReelFeed(currentUserId: string, limit = 10, offset = 0, feed: 'foryou' | 'following' = 'foryou') {
  const blockedRows = await prisma.block.findMany({ where: { OR: [{ blockerId: currentUserId }, { blockedId: currentUserId }] } });
  const blockedIds = new Set<string>();
  for (const b of blockedRows) blockedIds.add(b.blockerId === currentUserId ? b.blockedId : b.blockerId);
  const where = blockedIds.size ? { userId: { notIn: [...blockedIds] } } : {} as any;
  const safeLimit = Math.min(Math.max(limit, 1), 20);
  const safeOffset = Math.max(offset, 0);

  // --- Phase 2: Smart ranking data ---
  // Get user's interaction history for personalization
  const [viewHistory, likeHistory, followRows, currentUser, userInterests, notInterestedList] = await Promise.all([
    // Recent views with watch time (last 200)
    prisma.$queryRawUnsafe<Array<{ reel_id: string; user_id: string; watch_sec: number; completed: number }>>(
      `SELECT reel_id, viewer_id AS user_id, watch_sec, completed FROM reel_views WHERE viewer_id = ? ORDER BY created_at DESC LIMIT 200`,
      currentUserId
    ).catch(() => [] as Array<{ reel_id: string; user_id: string; watch_sec: number; completed: number }>),
    // Recent likes (last 200)
    prisma.reelLike.findMany({
      where: { userId: currentUserId },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { reelId: true },
    }).catch(() => []),
    // Follows
    prisma.follow.findMany({
      where: { followerId: currentUserId },
      select: { followingId: true },
    }).catch(() => []),
    // Current user location
    prisma.user.findUnique({
      where: { id: currentUserId },
      select: { city: true, country: true },
    }).catch(() => null),
    // User interests for personalization
    prisma.user.findUnique({ where: { id: currentUserId }, select: { interests: true } }).then(u => new Set<string>(Array.isArray(u?.interests) ? (u.interests as string[]) : [])).catch(() => new Set<string>()),
    // Not-interested feedback
    prisma.user.findUnique({ where: { id: currentUserId }, select: { notInterested: true } }).then(u => Array.isArray(u?.notInterested) ? (u.notInterested as any[]) : []).catch(() => [] as any[]),
  ]);

  // Build not-interested sets
  const interestedCats = new Set<string>();
  const notInterestedCats = new Set<string>();
  const notInterestedCreators = new Set<string>();
  for (const ni of notInterestedList) {
    if (ni.type === 'category') notInterestedCats.add(ni.value);
    else if (ni.type === 'interested_category') interestedCats.add(ni.value);
    else if (ni.type === 'creator') notInterestedCreators.add(ni.value);
  }

  // Build creator affinity map: creatorId -> score (0-1)
  const creatorStats = new Map<string, { watchTime: number; views: number; likes: number; completed: number }>();
  const likedReelIds = new Set(likeHistory.map((l) => l.reelId));
  const followingSet = new Set(followRows.map((f) => f.followingId));

  // Following tab: only reels from followed creators, chronological order
  const isFollowingFeed = feed === 'following';
  if (isFollowingFeed) {
    if (!followingSet.size) return { reels: [], hasMore: false };
    (where as any).userId = { in: [...followingSet], ...(blockedIds.size ? { notIn: [...blockedIds] } : {}) };
  }

  // Get reel authors for view history to build affinity
  const viewedReelIds = [...new Set(viewHistory.map((v) => v.reel_id))];
  let viewedReels: Array<{ id: string; userId: string; category: string | null }> = [];
  if (viewedReelIds.length) {
    viewedReels = await prisma.reel.findMany({
      where: { id: { in: viewedReelIds } },
      select: { id: true, userId: true, category: true },
    }).catch(() => []);
  }
  const reelAuthorMap = new Map(viewedReels.map((r) => [r.id, r.userId]));

  // Build category affinity from watch history (like Facebook: watch comedy = more comedy)
  const categoryWatch = new Map<string, number>();
  if (viewedReels.length) {
    const catMap = new Map(viewedReels.map((r) => [r.id, r.category]));
    for (const v of viewHistory) {
      const cat = catMap.get(v.reel_id);
      if (!cat) continue;
      const w = (Number(v.watch_sec) || 0) + (Number(v.completed) ? 10 : 0);
      categoryWatch.set(cat, (categoryWatch.get(cat) || 0) + w);
    }
  }
  // Top 3 watched categories get boost
  const topCats = [...categoryWatch.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c]) => c);
  const topCatSet = new Set(topCats);

  for (const v of viewHistory) {
    const authorId = reelAuthorMap.get(v.reel_id);
    if (!authorId || authorId === currentUserId) continue;
    const s = creatorStats.get(authorId) || { watchTime: 0, views: 0, likes: 0, completed: 0 };
    s.watchTime += Number(v.watch_sec) || 0;
    s.views += 1;
    if (Number(v.completed)) s.completed += 1;
    creatorStats.set(authorId, s);
  }
  // Add likes to affinity
  if (likedReelIds.size) {
    const likedReels = await prisma.reel.findMany({
      where: { id: { in: [...likedReelIds] } },
      select: { id: true, userId: true },
    }).catch(() => []);
    for (const r of likedReels) {
      if (r.userId === currentUserId) continue;
      const s = creatorStats.get(r.userId) || { watchTime: 0, views: 0, likes: 0, completed: 0 };
      s.likes += 1;
      creatorStats.set(r.userId, s);
    }
  }

  // Normalize affinity to 0-1
  let maxAffinity = 0;
  const affinityScores = new Map<string, number>();
  for (const [creatorId, s] of creatorStats) {
    // Weighted: likes count 3x, completed 2x, watch time matters
    const raw = s.likes * 30 + s.completed * 15 + Math.min(s.watchTime / 10, 50) + s.views * 2;
    affinityScores.set(creatorId, raw);
    if (raw > maxAffinity) maxAffinity = raw;
  }
  if (maxAffinity > 0) {
    for (const [k, v] of affinityScores) affinityScores.set(k, v / maxAffinity);
  }

  // Fetch candidate reels (more than needed for ranking)
  const candidateLimit = Math.min(safeOffset + safeLimit + 50, 150);
  const reels = await prisma.reel.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: candidateLimit,
    include: {
      user: { select: { id: true, city: true, country: true, username: true, displayName: true, profilePictureUrl: true, isVerified: true } },
      _count: { select: { likes: true, comments: true } },
      likes: { where: { userId: currentUserId }, select: { id: true } },
      favorites: { where: { userId: currentUserId }, select: { id: true } },
    },
  });

  // Get view counts for candidates
  const reelIds = reels.map((r) => r.id);
  let viewCounts = new Map<string, number>();
  if (reelIds.length) {
    try {
      const vc = await prisma.$queryRawUnsafe<Array<{ reel_id: string; cnt: bigint }>>(
        `SELECT reel_id, COUNT(*) AS cnt FROM reel_views WHERE reel_id IN (${reelIds.map(() => '?').join(',')}) GROUP BY reel_id`,
        ...reelIds
      );
      for (const row of vc) viewCounts.set(row.reel_id, Number(row.cnt));
    } catch {}
  }

  // Score each reel
  const now = Date.now();

  // SKIP DETECTION (user-ordered 2026-10-17): if the user's last view was a
  // skip (watched <3s or <30% without completing), the next feed should
  // prioritize FRESH reels — the user is bored, show them something new.
  let lastWasSkip = false;
  if (viewHistory.length > 0) {
    const last = viewHistory[0];
    const wsec = Number(last.watch_sec) || 0;
    const completed = Number(last.completed) === 1;
    if (!completed && wsec < 3) lastWasSkip = true;
  }

  const scored = reels.map((r) => {
    let score = 0;
    const isMine = r.userId === currentUserId;
    const ageHours = (now - new Date(r.createdAt).getTime()) / (1000 * 60 * 60);

    // SKIP BOOST: after a skip, fresh (<6h) unseen reels get +30 to surface immediately
    if (lastWasSkip && ageHours < 6 && !viewedReelIds.includes(r.id)) {
      score += 30;
    }

    // 1. Creator affinity (0-50 points) - STRONG: watch a lot = see a lot more
    const affinity = affinityScores.get(r.userId) || 0;
    score += affinity * 50;

    // 2. Following bonus (20 points)
    if (followingSet.has(r.userId)) score += 20;

    // 3. Engagement score (0-20 points, log scale)
    const likes = r._count.likes;
    const comments = r._count.comments;
    const views = viewCounts.get(r.id) || 0;
    const engagement = Math.log10(1 + likes + comments * 2 + views * 0.5);
    score += Math.min(engagement * 5, 20);

    // 4. Recency (0-15 points, decays over 7 days)
    const recency = Math.max(0, 1 - ageHours / 168); // 168h = 7 days
    score += recency * 15;

    // 5. Location bonus
    if (currentUser && r.user) {
      if (currentUser.city && r.user.city && currentUser.city === r.user.city) score += 10;
      else if (currentUser.country && r.user.country && currentUser.country === r.user.country) score += 5;
    }

    // 6. Own reels get slight boost (user wants to see their own)
    if (isMine) score += 5;

    // 7b. Verified creator boost (Blue Tick perk: better reach)
    if (r.user?.isVerified) score += 12;
    // Interest boosts: take the MAX, not the sum (avoid +100 stacking)
    // Settings interest (+25), watched a lot (+35), explicit "Interested" (+40)
    if (r.category) {
      let interestBoost = 0;
      if (userInterests.has(r.category)) interestBoost = Math.max(interestBoost, 25);
      if (topCatSet.has(r.category)) interestBoost = Math.max(interestBoost, 35);
      if (interestedCats.has(r.category)) interestBoost = Math.max(interestBoost, 40);
      score += interestBoost;
    }
    // Not-interested penalty (Facebook-style feedback)
    if (r.category && notInterestedCats.has(r.category)) score -= 50;
    if (notInterestedCreators.has(r.userId)) score -= 50;

    // 7. Penalize already-seen reels (avoid repeats)
    if (viewedReelIds.includes(r.id)) score -= 15;

    return { reel: r, score };
  });

  // Sort by score (desc), then by recency for ties (For You only;
  // Following tab stays chronological as fetched from the DB)
  if (!isFollowingFeed) {
    scored.sort((a, b) => {
      if (Math.abs(a.score - b.score) > 0.01) return b.score - a.score;
      return new Date(b.reel.createdAt).getTime() - new Date(a.reel.createdAt).getTime();
    });

    // NEW REEL DISCOVERY (user-ordered 2026-10-17): guarantee fresh reels surface.
    // Without this, old viral reels (affinity 50 + following 20 + engagement 20 = 90pts)
    // bury brand-new reels (recency 15 max). Like the post feed's exploration slot,
    // ensure at least 3 fresh (<6h) reels appear in the top 10 so new creators get growth.
    if (safeOffset === 0) {
      const nowMs = Date.now();
      const isFresh = (s: typeof scored[number]) =>
        (nowMs - new Date(s.reel.createdAt).getTime()) / 3600000 < 6;
      const freshInTop10 = scored.slice(0, 10).filter(isFresh).length;
      const need = Math.max(0, 3 - freshInTop10);
      if (need > 0) {
        const picked: typeof scored = [];
        const rest = scored.filter((x, i) => {
          if (i >= 10 && isFresh(x) && picked.length < need) { picked.push(x); return false; }
          return true;
        });
        // Insert fresh reels at positions 2, 5, 8 (spread through the feed)
        const positions = [1, 4, 7];
        picked.forEach((item, k) => rest.splice(positions[k] ?? 9, 0, item));
        scored.length = 0;
        scored.push(...rest);
      }

      // OWN NEW REEL FIRST (user-ordered 2026-10-17): when you upload a reel,
      // you see it at the very top the 1st time. After you've viewed it (reload),
      // normal ranking applies. Only for reels <1h old.
      const ownFreshUnviewed = scored.filter((x) => {
        const ageH = (nowMs - new Date(x.reel.createdAt).getTime()) / 3600000;
        return x.reel.userId === currentUserId && ageH < 1 && !viewedReelIds.includes(x.reel.id);
      });
      if (ownFreshUnviewed.length > 0) {
        // Freshest first
        ownFreshUnviewed.sort((a, b) => new Date(b.reel.createdAt).getTime() - new Date(a.reel.createdAt).getTime());
        const top = ownFreshUnviewed[0];
        const idx = scored.indexOf(top);
        if (idx > 0) {
          scored.splice(idx, 1);
          scored.unshift(top);
        }
      }

      // ANTI-BOREDOM DIVERSITY (user-ordered 2026-10-17): never show 2 reels
      // from the same creator back-to-back, and avoid 3 same-category reels
      // in a row. Keeps the feed feeling fresh like TikTok/IG.
      const diversified: typeof scored = [];
      const remaining = [...scored];
      while (remaining.length > 0) {
        // Find the highest-ranked reel that doesn't repeat the last creator
        let pickIdx = 0;
        if (diversified.length > 0) {
          const lastCreator = diversified[diversified.length - 1].reel.userId;
          const lastCat = (diversified[diversified.length - 1].reel as any).category;
          const secondLastCat = diversified.length > 1
            ? (diversified[diversified.length - 2].reel as any).category
            : null;
          pickIdx = remaining.findIndex((x) => {
            if (x.reel.userId === lastCreator) return false;
            // Avoid 3rd same-category in a row
            const cat = (x.reel as any).category;
            if (cat && cat === lastCat && cat === secondLastCat) return false;
            return true;
          });
          if (pickIdx === -1) pickIdx = 0; // all remaining are same creator — take best
        }
        diversified.push(remaining[pickIdx]);
        remaining.splice(pickIdx, 1);
      }
      scored.length = 0;
      scored.push(...diversified);
    }
  }

  // Apply pagination on ranked results
  const paged = scored.slice(safeOffset, safeOffset + safeLimit);
  const total = scored.length;

  const authorIds = [...new Set(paged.map((s) => s.reel.userId))];
  const followStatusRows = authorIds.length
    ? await prisma.follow.findMany({
        where: {
          OR: [
            { followerId: currentUserId, followingId: { in: authorIds } },
            { followerId: { in: authorIds }, followingId: currentUserId },
          ],
        },
        select: { followerId: true, followingId: true },
      }).catch(() => [])
    : [];
  const followingSet2 = new Set(followStatusRows.filter((f) => f.followerId === currentUserId).map((f) => f.followingId));
  const followerSet = new Set(followStatusRows.filter((f) => f.followingId === currentUserId).map((f) => f.followerId));

  // Attach each reel's permanent share code (generated once on first share,
  // reused forever) so clients never need a per-open share-link API call.
  const pagedReelIds = paged.map((s) => s.reel.id);
  const shareRows = pagedReelIds.length
    ? await prisma.shareLink.findMany({
        where: { targetType: 'reel', targetId: { in: pagedReelIds } },
        select: { targetId: true, code: true },
      }).catch(() => [] as Array<{ targetId: string; code: string }>)
    : [];
  const shareCodeMap = new Map(shareRows.map((s) => [s.targetId, s.code]));

  const reelsWithStatus = paged.map(({ reel: r }) => {
    const isMine = r.userId === currentUserId;
    const iFollow = followingSet2.has(r.userId);
    const theyFollow = followerSet.has(r.userId);
    const friendStatus = isMine ? 'self' : iFollow && theyFollow ? 'friends' : iFollow ? 'following' : theyFollow ? 'follower' : 'none';
    const author = r.user ? { id: r.user.id, username: (r.user as any).username || '', displayName: ((r.user as any).displayName || '').trim(), profilePictureUrl: (r.user as any).profilePictureUrl || null, isVerified: !!(r.user as any).isVerified } : null;
    return { id: r.id, videoUrl: r.videoUrl, thumbnailUrl: r.thumbnailUrl, caption: r.caption, category: (r as any).category || null, durationSec: r.durationSec, createdAt: r.createdAt, userId: r.userId, author, likeCount: r._count.likes, commentCount: r._count.comments, viewCount: viewCounts.get(r.id) || 0, liked: (r as any).likes?.length > 0, favorited: (r as any).favorites?.length > 0, isMine, friendStatus, shareCode: shareCodeMap.get(r.id) ?? null };
  });
  return { reels: reelsWithStatus, hasMore: safeOffset + paged.length < total };
}

export async function toggleReelLike(userId: string, reelId: string) {
  const result = await toggleReelLikeCore(userId, reelId);
  if (result.liked) {
    try {
      const reel = await prisma.reel.findUnique({ where: { id: reelId }, select: { userId: true } });
      if (reel) await createNotification({ userId: reel.userId, actorId: userId, type: 'reel_like', reelId });
    } catch (err) {
      console.error('[notify] reel like notification failed', err);
    }
  }
  return result;
}

async function toggleReelLikeCore(userId: string, reelId: string) {
  const reel = await prisma.reel.findUnique({ where: { id: reelId } });
  if (!reel) throw new ApiError(404, 'REEL_NOT_FOUND', 'Reel not found.');
  if (await isEitherBlocked(userId, reel.userId)) throw new ApiError(403, 'BLOCKED', 'Cannot like this reel.');
  return prisma.$transaction(async (tx) => {
    const existing = await tx.reelLike.findUnique({ where: { reelId_userId: { reelId, userId } } });
    if (existing) await tx.reelLike.delete({ where: { id: existing.id } });
    else await tx.reelLike.create({ data: { reelId, userId } });
    const likeCount = await tx.reelLike.count({ where: { reelId } });
    return { liked: !existing, likeCount };
  }, { isolationLevel: 'Serializable' });
}

export async function toggleReelFavorite(userId: string, reelId: string) {
  const reel = await prisma.reel.findUnique({ where: { id: reelId } });
  if (!reel) throw new ApiError(404, 'REEL_NOT_FOUND', 'Reel not found.');
  if (await isEitherBlocked(userId, reel.userId)) throw new ApiError(403, 'BLOCKED', 'Cannot favorite this reel.');
  return prisma.$transaction(async (tx) => {
    const existing = await tx.reelFavorite.findUnique({ where: { reelId_userId: { reelId, userId } } });
    if (existing) {
      await tx.reelFavorite.delete({ where: { id: existing.id } });
      return { favorited: false };
    }
    await tx.reelFavorite.create({ data: { reelId, userId } });
    return { favorited: true };
  }, { isolationLevel: 'Serializable' });
}

export async function getMyFavoriteReels(userId: string) {
  const blockedRows = await prisma.block.findMany({ where: { OR: [{ blockerId: userId }, { blockedId: userId }] }, select: { blockerId: true, blockedId: true } });
  const blockedIds = new Set<string>();
  for (const b of blockedRows) blockedIds.add(b.blockerId === userId ? b.blockedId : b.blockerId);
  const favorites = await prisma.reelFavorite.findMany({ where: { userId, reel: blockedIds.size ? { userId: { notIn: [...blockedIds] } } : {} }, orderBy: { createdAt: 'desc' }, include: { reel: { include: { user: { select: authorSelect }, _count: { select: { likes: true, comments: true } }, likes: { where: { userId }, select: { id: true } } } } } });
  const reels = await Promise.all(favorites.filter((f) => f.reel).map(async (f) => ({
    id: f.reel.id,
    videoUrl: f.reel.videoUrl,
    caption: f.reel.caption,
    durationSec: f.reel.durationSec,
    createdAt: f.reel.createdAt,
    likeCount: f.reel._count.likes,
    commentCount: f.reel._count.comments,
    liked: f.reel.likes.length > 0,
    favorited: true,
    isMine: f.reel.userId === userId,
    author: f.reel.user,
    friendStatus: await getFriendStatus(userId, f.reel.userId),
  })));
  return reels;
}

export async function deleteReel(userId: string, reelId: string) {
  const reel = await prisma.reel.findUnique({ where: { id: reelId } });
  if (!reel) throw new ApiError(404, 'REEL_NOT_FOUND', 'Reel not found.');
  if (reel.userId !== userId) throw new ApiError(403, 'FORBIDDEN', 'Not your reel.');
  await prisma.reel.delete({ where: { id: reelId } });
  if (reel.videoUrl) { try { await deleteFromR2(reel.videoUrl); } catch (err) { console.error('Failed to delete reel video from R2:', err); } }
  if (reel.thumbnailUrl) { try { await deleteFromR2(reel.thumbnailUrl); } catch (err) { console.error('Failed to delete reel cover from R2:', err); } }
  return { deleted: true };
}

export async function getMyDailyReelStatus(userId: string) {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const count = await prisma.reel.count({ where: { userId, createdAt: { gt: oneDayAgo } } });
  return { postedToday: count, remaining: Math.max(0, env.reelDailyLimit - count) };
}

export async function getReelById(reelId: string, currentUserId: string) {
  const reel = await prisma.reel.findUnique({
    where: { id: reelId },
    include: {
      user: true,
      _count: { select: { likes: true, comments: true } },
      likes: { where: { userId: currentUserId }, select: { id: true } },
      favorites: { where: { userId: currentUserId }, select: { id: true } },
    },
  });
  if (!reel) throw new ApiError(404, 'REEL_NOT_FOUND', 'Reel not found.');
  const isMine = reel.userId === currentUserId;
  if (!isMine) {
    if (await isEitherBlocked(currentUserId, reel.userId)) throw new ApiError(404, 'REEL_NOT_FOUND', 'Reel not found.');
    if (reel.user.isPrivate) {
      const status = await getFriendStatus(currentUserId, reel.userId);
      if (status !== 'following' && status !== 'friends') throw new ApiError(403, 'PRIVATE_ACCOUNT', 'This account is private.');
    }
  }
  const friendStatus = isMine ? 'self' : await getFriendStatus(currentUserId, reel.userId);
  return {
    id: reel.id,
    videoUrl: reel.videoUrl,
    thumbnailUrl: reel.thumbnailUrl,
    caption: reel.caption,
    durationSec: reel.durationSec,
    createdAt: reel.createdAt,
    likeCount: reel._count.likes,
    commentCount: reel._count.comments,
    liked: reel.likes.length > 0,
    favorited: reel.favorites.length > 0,
    isMine,
    author: { id: reel.user.id, username: reel.user.username, displayName: (reel.user.displayName || '').trim(), profilePictureUrl: reel.user.profilePictureUrl, isVerified: reel.user.isVerified },
    friendStatus,
  };
}

export async function getReelsByUsername(username: string, currentUserId: string) {
  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found.');
  const isOwner = currentUserId === user.id;
  if (!isOwner) {
    if (await isEitherBlocked(currentUserId, user.id)) return [];
    if (user.isPrivate) {
      const friendStatus = await getFriendStatus(currentUserId, user.id);
      if (friendStatus !== 'following' && friendStatus !== 'friends') return [];
    }
  }
  const reels = await prisma.reel.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    include: {
      user: { select: authorSelect },
      _count: { select: { likes: true, comments: true } },
      likes: { where: { userId: currentUserId }, select: { id: true } },
      favorites: { where: { userId: currentUserId }, select: { id: true } },
    },
  });
  const friendStatus = isOwner ? 'self' : await getFriendStatus(currentUserId, user.id);
  return reels.map((r) => ({
    id: r.id,
    videoUrl: r.videoUrl,
    thumbnailUrl: r.thumbnailUrl,
    caption: r.caption,
    durationSec: r.durationSec,
    createdAt: r.createdAt,
    likeCount: r._count.likes,
    commentCount: r._count.comments,
    liked: r.likes.length > 0,
    favorited: r.favorites.length > 0,
    isMine: isOwner,
    author: r.user,
    friendStatus,
  }));
}
