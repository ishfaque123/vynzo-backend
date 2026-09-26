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
    userReels,
    postViewRows,
    previousPostViews,
    previousReelViews,
    topPostViewGroups,
    topReelViewGroups,
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
    prisma.reel.findMany({ where: { userId }, select: { id: true } }),
    prisma.postView.findMany({ where: { post: { userId }, createdAt: { gte: since } }, select: { createdAt: true } }),
    prisma.postView.count({ where: { post: { userId }, createdAt: { gte: previousSince, lt: since } } }),
    prisma.reelView.count({ where: { reel: { userId }, createdAt: { gte: previousSince, lt: since } } }),
    prisma.postView.groupBy({
      by: ['postId'],
      where: { post: { userId, createdAt: { gte: monthStart } }, createdAt: { gte: monthStart } },
      _count: { _all: true },
      orderBy: { _count: { postId: 'desc' } },
      take: 1,
    }),
    prisma.reelView.groupBy({
      by: ['reelId'],
      where: { reel: { userId, createdAt: { gte: monthStart } }, createdAt: { gte: monthStart } },
      _count: { _all: true },
      orderBy: { _count: { reelId: 'desc' } },
      take: 1,
    }),
  ]);

  const reelIds = userReels.map((r) => r.id);
  const reelViewRows = reelIds.length
    ? await prisma.reelView.findMany({ where: { reelId: { in: reelIds }, createdAt: { gte: since } }, select: { createdAt: true } })
    : [];

  const views = postViewRows.length + reelViewRows.length;
  const previousViews = previousPostViews + previousReelViews;
  const viewsTrendPct = previousViews === 0 ? null : Math.round(((views - previousViews) / previousViews) * 100);
  const engagement = postLikes + postComments + postShares + reelLikes + reelComments;
  const content = postCount + reelCount + statusCount;
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
          title: topPost.content,
          mediaUrl: topPost.imageUrl,
          createdAt: topPost.createdAt,
          views: topPostViewGroups[0]._count._all,
        }
      : null,
    topReel
      ? {
          type: 'reel' as const,
          id: topReel.id,
          title: topReel.caption || 'Reel',
          mediaUrl: topReel.thumbnailUrl,
          createdAt: topReel.createdAt,
          views: topReelViewGroups[0]._count._all,
        }
      : null,
  ]
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((a, b) => b.views - a.views)[0] || null;

  return { views, engagement, newFollowers, content, dailyViews, viewsTrendPct, topPerforming };
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
