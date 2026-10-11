import { prisma } from '../config/prisma';

const DAY_MS = 24 * 60 * 60 * 1000;

export async function getDashboardStats(userId: string, days = 30) {
  const now = new Date();
  const since = new Date(now.getTime() - days * DAY_MS);
  const previousSince = new Date(since.getTime() - days * DAY_MS);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [
    postCount, reelCount, statusCount,
    postLikes, postComments, postShares,
    reelLikes, reelComments,
    newFollowers,
    prevNewFollowers,
    prevPostCount, prevReelCount, prevStatusCount,
    userReels,
    postViewRows,
    previousPostViews,
    topPostViewGroups,
    prevPostLikes, prevPostComments, prevPostShares,
    prevReelLikes, prevReelComments,
  ] = await Promise.all([
    prisma.post.count({ where: { userId, createdAt: { gte: since }, originalPostId: null } }),
    prisma.reel.count({ where: { userId, createdAt: { gte: since } } }),
    prisma.status.count({ where: { userId, createdAt: { gte: since } } }),
    prisma.like.count({ where: { post: { userId }, createdAt: { gte: since } } }),
    prisma.comment.count({ where: { post: { userId }, createdAt: { gte: since } } }),
    prisma.post.count({ where: { originalPost: { userId }, createdAt: { gte: since } } }),
    prisma.reelLike.count({ where: { reel: { userId }, createdAt: { gte: since } } }),
    prisma.reelComment.count({ where: { reel: { userId }, createdAt: { gte: since } } }),
    prisma.follow.count({ where: { followingId: userId, createdAt: { gte: since } } }),
    prisma.follow.count({ where: { followingId: userId, createdAt: { gte: previousSince, lt: since } } }),
    prisma.post.count({ where: { userId, createdAt: { gte: previousSince, lt: since }, originalPostId: null } }),
    prisma.reel.count({ where: { userId, createdAt: { gte: previousSince, lt: since } } }),
    prisma.status.count({ where: { userId, createdAt: { gte: previousSince, lt: since } } }),
    prisma.reel.findMany({ where: { userId }, select: { id: true } }),
    prisma.postView.findMany({ where: { post: { userId }, createdAt: { gte: since } }, select: { createdAt: true } }),
    prisma.postView.count({ where: { post: { userId }, createdAt: { gte: previousSince, lt: since } } }),
    prisma.postView.groupBy({
      by: ['postId'],
      where: { post: { userId, createdAt: { gte: monthStart } }, createdAt: { gte: monthStart } },
      _count: { postId: true },
      orderBy: { _count: { postId: 'desc' } },
      take: 1,
    }),
    prisma.like.count({ where: { post: { userId }, createdAt: { gte: previousSince, lt: since } } }),
    prisma.comment.count({ where: { post: { userId }, createdAt: { gte: previousSince, lt: since } } }),
    prisma.post.count({ where: { originalPost: { userId }, createdAt: { gte: previousSince, lt: since } } }),
    prisma.reelLike.count({ where: { reel: { userId }, createdAt: { gte: previousSince, lt: since } } }),
    prisma.reelComment.count({ where: { reel: { userId }, createdAt: { gte: previousSince, lt: since } } }),
  ]);

  const reelIds = userReels.map((r) => r.id);

  const [reelViewRows, previousReelViews, topReelViewGroups] = reelIds.length
    ? await Promise.all([
        prisma.reelView.findMany({
          where: { reelId: { in: reelIds }, createdAt: { gte: since } },
          select: { createdAt: true },
        }),
        prisma.reelView.count({
          where: { reelId: { in: reelIds }, createdAt: { gte: previousSince, lt: since } },
        }),
        prisma.reelView.groupBy({
          by: ['reelId'],
          where: { reelId: { in: reelIds }, createdAt: { gte: monthStart } },
          _count: { reelId: true },
          orderBy: { _count: { reelId: 'desc' } },
          take: 1,
        }),
      ])
    : [[], 0, []];

  const views = postViewRows.length + reelViewRows.length;
  const previousViews = previousPostViews + previousReelViews;
  const viewsTrendPct = previousViews === 0 ? null : Math.round(((views - previousViews) / previousViews) * 100);
  const engagement = postLikes + postComments + postShares + reelLikes + reelComments;
  const prevEngagement = prevPostLikes + prevPostComments + prevPostShares + prevReelLikes + prevReelComments;
  const engagementTrendPct = prevEngagement === 0 ? null : Math.round(((engagement - prevEngagement) / prevEngagement) * 100);
  const engagementBreakdown = {
    likes: postLikes + reelLikes,
    comments: postComments + reelComments,
    shares: postShares,
  };
  const content = postCount + reelCount + statusCount;
  const prevContent = prevPostCount + prevReelCount + prevStatusCount;
  const followersTrendPct = prevNewFollowers === 0 ? null : Math.round(((newFollowers - prevNewFollowers) / prevNewFollowers) * 100);
  const contentTrendPct = prevContent === 0 ? null : Math.round(((content - prevContent) / prevContent) * 100);
  const dailyViews = buildDailyBuckets([...postViewRows, ...reelViewRows].map((r) => r.createdAt), days);

  const topPost = topPostViewGroups[0]
    ? await prisma.post.findUnique({
        where: { id: topPostViewGroups[0].postId },
        select: { id: true, content: true, imageUrl: true, createdAt: true },
      })
    : null;
  const topReel = topReelViewGroups[0]
    ? await prisma.reel.findUnique({
        where: { id: topReelViewGroups[0].reelId },
        select: { id: true, caption: true, thumbnailUrl: true, createdAt: true },
      })
    : null;

  const topPerforming = [
    topPost
      ? {
          type: 'post' as const,
          id: topPost.id,
          title: topPost.content?.trim() || (topPost.imageUrl ? 'Photo post' : 'Post'),
          mediaUrl: topPost.imageUrl,
          createdAt: topPost.createdAt,
          views: topPostViewGroups[0]._count.postId,
        }
      : null,
    topReel
      ? {
          type: 'reel' as const,
          id: topReel.id,
          title: topReel.caption || 'Reel',
          mediaUrl: topReel.thumbnailUrl,
          createdAt: topReel.createdAt,
          views: topReelViewGroups[0]._count.reelId,
        }
      : null,
  ]
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((a, b) => b.views - a.views)[0] || null;

  return { views, engagement, engagementBreakdown, engagementTrendPct, newFollowers, followersTrendPct, content, contentTrendPct, dailyViews, viewsTrendPct, topPerforming, days };
}

function buildDailyBuckets(dates: Date[], days: number) {
  const buckets = new Map<string, number>();
  for (let i = days - 1; i >= 0; i--) {
    const key = new Date(Date.now() - i * DAY_MS).toISOString().slice(0, 10);
    buckets.set(key, 0);
  }
  dates.forEach((d) => {
    const key = new Date(d).toISOString().slice(0, 10);
    if (buckets.has(key)) buckets.set(key, (buckets.get(key) || 0) + 1);
  });
  return Array.from(buckets.entries()).map(([date, views]) => ({ date, views }));
}
