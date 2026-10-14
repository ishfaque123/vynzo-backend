import { prisma } from '../config/prisma';

/** All achievements. icon is an emoji-free key mapped to SVG on the client. */
export const ACHIEVEMENTS = [
  { key: 'first_story', name: 'Storyteller', description: 'Posted your first story', icon: 'story' },
  { key: 'streak_7', name: 'On Fire', description: '7-day story streak', icon: 'fire' },
  { key: 'streak_30', name: 'Unstoppable', description: '30-day story streak', icon: 'fire' },
  { key: 'first_post', name: 'First Post', description: 'Shared your first post', icon: 'post' },
  { key: 'first_reel', name: 'Reel Debut', description: 'Posted your first reel', icon: 'reel' },
  { key: 'followers_100', name: 'Century', description: 'Reached 100 followers', icon: 'followers' },
  { key: 'followers_1000', name: 'Influencer', description: 'Reached 1,000 followers', icon: 'followers' },
  { key: 'followers_10000', name: 'Celebrity', description: 'Reached 10,000 followers', icon: 'star' },
  { key: 'likes_1000', name: 'Loved', description: 'Received 1,000 likes', icon: 'heart' },
  { key: 'verified', name: 'Verified', description: 'Earned the blue tick', icon: 'verified' },
  { key: 'weekly_champion', name: 'Weekly Champion', description: 'Completed all weekly goals', icon: 'trophy' },
] as const;

export type AchievementKey = (typeof ACHIEVEMENTS)[number]['key'];

async function ensureDefinitions() {
  for (const a of ACHIEVEMENTS) {
    await prisma.achievement.upsert({
      where: { key: a.key },
      update: { name: a.name, description: a.description, icon: a.icon },
      create: { key: a.key, name: a.name, description: a.description, icon: a.icon },
    });
  }
}

/** Award an achievement if not already earned. Returns the achievement if newly earned. */
export async function awardAchievement(userId: string, key: AchievementKey) {
  await ensureDefinitions();
  const def = await prisma.achievement.findUnique({ where: { key } });
  if (!def) return null;
  const existing = await prisma.userAchievement.findUnique({
    where: { userId_achievementId: { userId, achievementId: def.id } },
  });
  if (existing) return null;
  await prisma.userAchievement.create({ data: { userId, achievementId: def.id } });
  return def;
}

export async function getUserAchievements(userId: string) {
  await ensureDefinitions();
  const earned = await prisma.userAchievement.findMany({
    where: { userId },
    include: { achievement: true },
    orderBy: { earnedAt: 'desc' },
  });
  return earned.map((e) => ({
    key: e.achievement.key,
    name: e.achievement.name,
    description: e.achievement.description,
    icon: e.achievement.icon,
    earnedAt: e.earnedAt,
  }));
}

/** Update story streak. Call when a user posts a story. Returns current streak. */
export async function updateStoryStreak(userId: string): Promise<number> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { storyStreak: true, lastStoryDate: true },
  });
  if (!user) return 0;

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const lastDate = user.lastStoryDate
    ? new Date(user.lastStoryDate.getFullYear(), user.lastStoryDate.getMonth(), user.lastStoryDate.getDate())
    : null;

  let streak = user.storyStreak;
  if (!lastDate) {
    streak = 1;
  } else {
    const diffDays = Math.round((today.getTime() - lastDate.getTime()) / 86400000);
    if (diffDays === 0) {
      // Already posted today — streak unchanged.
    } else if (diffDays === 1) {
      streak = user.storyStreak + 1;
    } else {
      streak = 1; // Streak broken.
    }
  }

  await prisma.user.update({
    where: { id: userId },
    data: { storyStreak: streak, lastStoryDate: now },
  });

  // Streak milestone achievements.
  if (streak >= 30) await awardAchievement(userId, 'streak_30');
  else if (streak >= 7) await awardAchievement(userId, 'streak_7');

  return streak;
}

/** Check follower-milestone achievements. Call after a follow. */
export async function checkFollowerMilestones(userId: string) {
  const count = await prisma.follow.count({ where: { followingId: userId } });
  if (count >= 10000) await awardAchievement(userId, 'followers_10000');
  else if (count >= 1000) await awardAchievement(userId, 'followers_1000');
  else if (count >= 100) await awardAchievement(userId, 'followers_100');
  return count;
}
