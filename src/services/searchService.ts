import { prisma } from '../config/prisma';
import { toPostDTO, includeShape } from './postService';

/**
 * v5.18 (staged, NOT deployed): free-text search across public posts and
 * reels — GET /api/search?q=&type=posts|reels|all&limit=&offset=.
 * Mirrors tagService.ts exactly (same blocked / private / hidden rules,
 * same merged newest-first timeline, same DTO shapes, take: 200 pre-filter
 * + in-memory check), except the match is a plain case-insensitive
 * substring of the query instead of a standalone #tag regex. Hashtags are
 * NOT stored anywhere — they are matched at runtime, same as tags.
 * No new table, column, index or migration; no `prisma db push` ever.
 */
function toAuthorDTO(user: any) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username || '',
    displayName: user.displayName || '',
    profilePictureUrl: user.profilePictureUrl || null,
    isVerified: !!user.isVerified,
  };
}

export async function searchContent(
  rawQuery: string,
  currentUserId?: string,
  type: 'posts' | 'reels' | 'all' = 'all',
  limit = 20,
  offset = 0
) {
  const q = rawQuery.trim();
  if (!q) {
    return { q: '', posts: [], reels: [], hasMore: false };
  }

  const safeLimit = Math.min(Math.max(limit, 1), 50);
  const safeOffset = Math.max(offset, 0);
  const needle = q.toLowerCase();

  const [blockedRows, followingRows] = currentUserId
    ? await Promise.all([
        prisma.block.findMany({
          where: { OR: [{ blockerId: currentUserId }, { blockedId: currentUserId }] },
          select: { blockerId: true, blockedId: true },
        }),
        prisma.follow.findMany({
          where: { followerId: currentUserId },
          select: { followingId: true },
        }),
      ])
    : [[], []];
  const blockedIds = new Set<string>();
  for (const b of blockedRows as any[]) {
    blockedIds.add(b.blockerId === currentUserId ? b.blockedId : b.blockerId);
  }
  const followingIds = new Set((followingRows as any[]).map((f) => f.followingId));
  const hiddenIds = currentUserId
    ? (await prisma.hiddenPost.findMany({ where: { userId: currentUserId }, select: { postId: true } })).map((h: any) => h.postId)
    : [];

  // --- Posts ---
  let matchingPosts: any[] = [];
  if (type === 'posts' || type === 'all') {
    const postCandidates = await prisma.post.findMany({
      where: {
        visibility: 'public',
        content: { contains: q },
        ...(hiddenIds.length ? { id: { notIn: hiddenIds } } : {}),
        ...(blockedIds.size ? { userId: { notIn: [...blockedIds] } } : {}),
      },
      include: includeShape,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    matchingPosts = postCandidates.filter(
      (p: any) =>
        (p.content || '').toLowerCase().includes(needle) &&
        (!p.user.isPrivate || p.userId === currentUserId || followingIds.has(p.userId))
    );
  }

  // --- Reels ---
  let matchingReels: any[] = [];
  if (type === 'reels' || type === 'all') {
    const reelCandidates = await prisma.reel.findMany({
      where: {
        caption: { contains: q },
        ...(blockedIds.size ? { userId: { notIn: [...blockedIds] } } : {}),
      },
      include: {
        user: true,
        _count: { select: { likes: true, comments: true } },
        ...(currentUserId
          ? { likes: { where: { userId: currentUserId }, select: { userId: true } } }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    matchingReels = reelCandidates.filter(
      (r: any) =>
        (r.caption || '').toLowerCase().includes(needle) &&
        (!r.user?.isPrivate || r.userId === currentUserId || followingIds.has(r.userId))
    );
  }

  // Merge timeline: newest first across both types
  const merged = [
    ...matchingPosts.map((p: any) => ({ kind: 'post' as const, at: new Date(p.createdAt).getTime(), p })),
    ...matchingReels.map((r: any) => ({ kind: 'reel' as const, at: new Date((r as any).createdAt).getTime(), r })),
  ].sort((a, b) => b.at - a.at);

  const page = merged.slice(safeOffset, safeOffset + safeLimit);
  const hasMore = merged.length > safeOffset + safeLimit;

  // Share codes for the page's reels (posts get theirs via toPostDTO's map)
  const pageReelIds = page.filter((x) => x.kind === 'reel').map((x) => (x as any).r.id);
  const reelShareRows = pageReelIds.length
    ? await prisma.shareLink
        .findMany({
          where: { targetType: 'reel', targetId: { in: pageReelIds } },
          select: { targetId: true, code: true },
        })
        .catch(() => [] as Array<{ targetId: string; code: string }>)
    : [];
  const reelShareMap = new Map(reelShareRows.map((s: any) => [s.targetId, s.code]));
  const pagePostIds = page.filter((x) => x.kind === 'post').map((x) => (x as any).p.id);
  const postShareRows = pagePostIds.length
    ? await prisma.shareLink
        .findMany({
          where: { targetType: 'post', targetId: { in: pagePostIds } },
          select: { targetId: true, code: true },
        })
        .catch(() => [] as Array<{ targetId: string; code: string }>)
    : [];
  const postShareMap = new Map(postShareRows.map((s: any) => [s.targetId, s.code]));

  const posts: any[] = [];
  const reels: any[] = [];
  for (const item of page) {
    if (item.kind === 'post') {
      posts.push(await toPostDTO((item as any).p, currentUserId, postShareMap));
    } else {
      const r: any = (item as any).r;
      reels.push({
        id: r.id,
        videoUrl: r.videoUrl,
        thumbnailUrl: r.thumbnailUrl || null,
        caption: r.caption || null,
        durationSec: r.durationSec ?? null,
        createdAt: r.createdAt,
        userId: r.userId,
        author: toAuthorDTO(r.user),
        likeCount: r._count?.likes ?? 0,
        commentCount: r._count?.comments ?? 0,
        liked: Array.isArray(r.likes) && r.likes.length > 0,
        favorited: false,
        isMine: r.userId === currentUserId,
        shareCode: reelShareMap.get(r.id) ?? null,
      });
    }
  }

  return { q, posts, reels, hasMore };
}
