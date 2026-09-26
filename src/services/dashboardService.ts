import { prisma } from '../config/prisma';

const DAY_MS = 24 * 60 * 60 * 1000;

export async function getDashboardStats(userId: string, days = 30) {
  const since = new Date(Date.now() - days * DAY_MS);

  const [
    postCount, reelCount, statusCount,
    postLikes, postComments, postShares,
    reelLikes, reelComments,
    newFollowers,
    userReels,
    postViewRows,
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
  ]);

  const reelIds = userReels.map((r) => r.id);
  const reelViewRows = reelIds.length
    ? await prisma.reelView.findMany({ where: { reelId: { in: reelIds }, createdAt: { gte: since } }, select: { createdAt: true } })
    : [];

  const views = postViewRows.length + reelViewRows.length;
  const engagement = postLikes + postComments + postShares + reelLikes + reelComments;
  const content = postCount + reelCount + statusCount;
  const dailyViews = buildDailyBuckets([...postViewRows, ...reelViewRows].map((r) => r.createdAt), days);

  return { views, engagement, newFollowers, content, dailyViews };
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
