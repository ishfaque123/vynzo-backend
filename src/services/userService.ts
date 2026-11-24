import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';
import { getFriendStatus } from './followService';
import { isUserOnline } from '../socket/socketServer';
import { getBlockStatus } from './blockService';
import { normalizeCountry } from '../utils/country';

const COOLDOWN_DAYS = 30;

// Profile Intro section (owner feature 2026-11-21): a fixed category list,
// optional social links, and a per-field Public/Lock choice. A locked field
// is never sent to other viewers at all. Phone and email are locked by
// default; every other field is public by default.
export const PROFILE_CATEGORIES = ['Personal', 'Video Creator', 'Business', 'Artist', 'Public Figure', 'Other'];
export const SOCIAL_LINK_KEYS = ['facebook', 'instagram', 'youtube', 'tiktok'];
export const INTRO_PRIVACY_KEYS = ['category', 'location', 'dateOfBirth', 'gender', 'website', 'facebook', 'instagram', 'youtube', 'tiktok', 'phone', 'email'];
const INTRO_PRIVATE_BY_DEFAULT = new Set(['phone', 'email']);

export function introFieldVisible(privacy: any, key: string): boolean {
  const value = privacy && typeof privacy === 'object' ? privacy[key] : undefined;
  if (typeof value === 'boolean') return value;
  return !INTRO_PRIVATE_BY_DEFAULT.has(key);
}

export function buildIntro(user: any, isSelf: boolean) {
  const privacy = user.introPrivacy && typeof user.introPrivacy === 'object' ? user.introPrivacy : {};
  const links = user.socialLinks && typeof user.socialLinks === 'object' ? user.socialLinks : {};
  const show = (key: string) => isSelf || introFieldVisible(privacy, key);
  return {
    category: show('category') ? (user.category ?? null) : null,
    city: show('location') ? (user.city ?? null) : null,
    province: show('location') ? (user.province ?? null) : null,
    dateOfBirth: show('dateOfBirth') ? (user.dateOfBirth ?? null) : null,
    gender: show('gender') ? (user.gender ?? null) : null,
    website: show('website') ? (user.website ?? null) : null,
    facebook: show('facebook') ? (links.facebook ?? null) : null,
    instagram: show('instagram') ? (links.instagram ?? null) : null,
    youtube: show('youtube') ? (links.youtube ?? null) : null,
    tiktok: show('tiktok') ? (links.tiktok ?? null) : null,
    phone: show('phone') ? (user.phone ?? null) : null,
    email: show('email') ? (user.email ?? null) : null,
  };
}

export function toPrivateProfile(user: any) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    bio: user.bio,
    profilePictureUrl: user.profilePictureUrl,
    coverPhotoUrl: user.coverPhotoUrl,
    gender: user.gender,
    email: user.email,
    website: user.website,
    phone: user.phone,
    province: user.province,
    city: user.city,
    country: user.country,
    dateOfBirth: user.dateOfBirth,
    interests: user.interests ?? [],
    profileCompleted: user.profileCompleted,
    commentsDisabled: user.commentsDisabled,
    messagePermission: user.messagePermission,
    tagPermission: user.tagPermission,
    showOnlineStatus: user.showOnlineStatus,
    isPrivate: user.isPrivate,
    usernameChangedAt: user.usernameChangedAt,
    displayNameChangedAt: user.displayNameChangedAt,
    dobChangedAt: user.dobChangedAt,
    isVerified: user.isVerified ?? false,
    category: user.category ?? null,
    socialLinks: user.socialLinks ?? {},
    introPrivacy: user.introPrivacy ?? {},
    publicKey: user.publicKey ?? null,
    storyStreak: user.storyStreak ?? 0,
    loginStreak: user.loginStreak ?? 0,
    role: user.role ?? 'user',
  };
}

export function toPublicProfile(
  user: any,
  friendStatus?: string,
  extra?: { isOnline?: boolean; lastActiveAt?: Date | null; blockedByMe?: boolean; blockedByOther?: boolean; mutualFollowers?: { username: string | null; displayName: string | null }[]; mutualCount?: number; isSelf?: boolean; followersCount?: number; followingCount?: number }
) {
  const isSelf = extra?.isSelf ?? false;
  const privacy = user.introPrivacy && typeof user.introPrivacy === 'object' ? user.introPrivacy : {};
  const show = (key: string) => isSelf || introFieldVisible(privacy, key);
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    bio: user.bio,
    profilePictureUrl: user.profilePictureUrl,
    coverPhotoUrl: user.coverPhotoUrl,
    website: show('website') ? user.website : null,
    province: show('location') ? user.province : null,
    city: show('location') ? user.city : null,
    intro: buildIntro(user, isSelf),
    // Your own privacy choices are returned only to you, so Edit Profile
    // can show the current Public/Lock state of every Intro field.
    introPrivacy: isSelf ? privacy : undefined,
    country: user.country,
    createdAt: user.createdAt,
    friendStatus: friendStatus ?? 'none',
    isPrivate: user.isPrivate,
    isOnline: extra?.isOnline ?? false,
    lastActiveAt: extra?.lastActiveAt ?? null,
    blockedByMe: extra?.blockedByMe ?? false,
    blockedByOther: extra?.blockedByOther ?? false,
    isVerified: user.isVerified ?? false,
    mutualFollowers: extra?.mutualFollowers ?? [],
    mutualCount: extra?.mutualCount ?? 0,
    // Follow counts travel with the profile itself, so the numbers
    // render together with the name and photo instead of arriving
    // later through the separate counts request.
    followersCount: extra?.followersCount ?? 0,
    followingCount: extra?.followingCount ?? 0,
    storyStreak: user.storyStreak ?? 0,
    loginStreak: user.loginStreak ?? 0,
  };
}

export async function getMutualFollowers(profileUserId: string, currentUserId: string) {
  if (!currentUserId || currentUserId === profileUserId) return { mutuals: [], count: 0 };
  // People who follow the profile user AND are followed by the current user
  const where = {
    followingId: profileUserId,
    follower: {
      followers: { some: { followerId: currentUserId } },
    },
  };
  const rows = await prisma.follow.findMany({
    where,
    take: 3,
    include: { follower: { select: { username: true, displayName: true } } },
    orderBy: { createdAt: 'desc' },
  });
  const count = await prisma.follow.count({ where });
  return {
    mutuals: rows.map((r) => ({ username: r.follower.username, displayName: r.follower.displayName })),
    count,
  };
}

export async function getPublicProfileByUsername(username: string, currentUserId?: string) {
  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found.');

  const friendStatus = await getFriendStatus(currentUserId, user.id);
  const blockStatus = currentUserId
    ? await getBlockStatus(currentUserId, user.id)
    : { blockedByMe: false, blockedByOther: false };
  const mutual = currentUserId
    ? await getMutualFollowers(user.id, currentUserId)
    : { mutuals: [], count: 0 };
  const [followersCount, followingCount] = await Promise.all([
    prisma.follow.count({ where: { followingId: user.id } }),
    prisma.follow.count({ where: { followerId: user.id } }),
  ]);

  return toPublicProfile(user, friendStatus, {
    isSelf: Boolean(currentUserId) && currentUserId === user.id,
    isOnline: isUserOnline(user.id),
    lastActiveAt: user.lastActiveAt,
    ...blockStatus,
    mutualFollowers: mutual.mutuals,
    mutualCount: mutual.count,
    followersCount,
    followingCount,
  });
}

// Graduated change ladder for username and display name: the first change
// after profile setup is free, the next one opens after 7 days, and every
// change after that follows the standard 30-day cooldown.
function checkChangeLadder(lastChanged: Date | null, changeCount: number): { allowed: boolean; daysLeft: number } {
  if (changeCount <= 0) return { allowed: true, daysLeft: 0 };
  const waitDays = changeCount === 1 ? 7 : COOLDOWN_DAYS;
  if (!lastChanged) return { allowed: true, daysLeft: 0 };
  const daysSince = (Date.now() - lastChanged.getTime()) / (1000 * 60 * 60 * 24);
  if (daysSince >= waitDays) return { allowed: true, daysLeft: 0 };
  return { allowed: false, daysLeft: Math.ceil(waitDays - daysSince) };
}

function checkCooldown(lastChanged: Date | null): { allowed: boolean; daysLeft: number } {
  if (!lastChanged) return { allowed: true, daysLeft: 0 };
  const daysSince = (Date.now() - lastChanged.getTime()) / (1000 * 60 * 60 * 24);
  if (daysSince >= COOLDOWN_DAYS) return { allowed: true, daysLeft: 0 };
  return { allowed: false, daysLeft: Math.ceil(COOLDOWN_DAYS - daysSince) };
}

function normalizeData(data: any) {
  const result = { ...data };
  if (result.dateOfBirth) result.dateOfBirth = new Date(result.dateOfBirth);
  // Country-feed fix 2026-11-02: store the 2-letter code, not the full
  // name, so feed comparisons stop missing same-country matches.
  // Unknown values are kept as-is (never destroyed).
  if (typeof result.country === 'string' && result.country.trim()) {
    result.country = normalizeCountry(result.country) ?? result.country.trim();
  }
  return result;
}

export async function completeProfile(userId: string, data: any) {
  const existing = await prisma.user.findUnique({ where: { username: data.username } });
  if (existing && existing.id !== userId) throw new ApiError(409, 'USERNAME_TAKEN', 'Username already taken.');
  const now = new Date();
  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      ...normalizeData(data),
      profileCompleted: true,
      usernameChangedAt: now,
      displayNameChangedAt: now,
      dobChangedAt: now,
    },
  });

  // Auto-follow: every new user follows the official @frienzo account.
  // (NOT AI-gated — bots stay off. Never fails profile setup.)
  try {
    const { followOfficialForUser } = await import('./aiOutreachService');
    await followOfficialForUser(userId);
  } catch {}

  return updated;
}

export async function updateProfile(userId: string, data: any) {
  const current = await prisma.user.findUnique({ where: { id: userId } });
  if (!current) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found.');

  const updateData: any = { ...data };
  if (data.category !== undefined) {
    updateData.category = PROFILE_CATEGORIES.includes(data.category) ? data.category : null;
  }
  if (data.socialLinks !== undefined) {
    const src = data.socialLinks && typeof data.socialLinks === 'object' ? data.socialLinks : {};
    const cleanLinks: Record<string, string> = {};
    for (const key of SOCIAL_LINK_KEYS) {
      const value = typeof src[key] === 'string' ? src[key].trim().slice(0, 200) : '';
      if (value) cleanLinks[key] = value;
    }
    updateData.socialLinks = cleanLinks;
  }
  if (data.introPrivacy !== undefined) {
    const src = data.introPrivacy && typeof data.introPrivacy === 'object' ? data.introPrivacy : {};
    const cleanPrivacy: Record<string, boolean> = {};
    for (const key of INTRO_PRIVACY_KEYS) {
      if (typeof src[key] === 'boolean') cleanPrivacy[key] = src[key];
    }
    updateData.introPrivacy = cleanPrivacy;
  }
  if (typeof updateData.country === 'string' && updateData.country.trim()) {
    updateData.country = normalizeCountry(updateData.country) ?? updateData.country.trim();
  }

  if (data.username !== undefined && data.username !== current.username) {
    const ladder = checkChangeLadder(current.usernameChangedAt, current.usernameChangeCount);
    if (!ladder.allowed) {
      throw new ApiError(403, 'USERNAME_COOLDOWN', `You can change your username again in ${ladder.daysLeft} day(s).`);
    }
    const existing = await prisma.user.findUnique({ where: { username: data.username } });
    if (existing && existing.id !== userId) throw new ApiError(409, 'USERNAME_TAKEN', 'Username already taken.');
    updateData.usernameChangedAt = new Date();
    updateData.usernameChangeCount = current.usernameChangeCount + 1;
  }

  if (data.displayName !== undefined && data.displayName !== current.displayName) {
    const ladder = checkChangeLadder(current.displayNameChangedAt, current.displayNameChangeCount);
    if (!ladder.allowed) {
      throw new ApiError(403, 'DISPLAY_NAME_COOLDOWN', `You can change your name again in ${ladder.daysLeft} day(s).`);
    }
    updateData.displayNameChangedAt = new Date();
    updateData.displayNameChangeCount = current.displayNameChangeCount + 1;
  }

  if (data.dateOfBirth !== undefined) {
    const newDob = new Date(data.dateOfBirth).getTime();
    const oldDob = current.dateOfBirth ? current.dateOfBirth.getTime() : null;
    if (newDob !== oldDob) {
      const cooldown = checkCooldown(current.dobChangedAt);
      if (!cooldown.allowed) {
        throw new ApiError(403, 'DOB_COOLDOWN', `You can change your birthday again in ${cooldown.daysLeft} day(s).`);
      }
      updateData.dobChangedAt = new Date();
      updateData.dateOfBirth = new Date(data.dateOfBirth);
    } else {
      delete updateData.dateOfBirth;
    }
  }

  return prisma.user.update({ where: { id: userId }, data: updateData });
}

function searchMatchRank(user: { username: string | null; displayName: string | null }, normalizedQuery: string): number {
  const username = (user.username || '').toLowerCase();
  const displayName = (user.displayName || '').toLowerCase();
  if (username === normalizedQuery) return 0;
  if (displayName === normalizedQuery) return 1;
  if (username.startsWith(normalizedQuery)) return 2;
  if (displayName.startsWith(normalizedQuery)) return 3;
  return 4;
}

export async function searchUsers(query: string, currentUserId?: string) {
  const candidates = await prisma.user.findMany({
    where: { OR: [{ username: { contains: query } }, { displayName: { contains: query } }] },
    take: 100,
  });

  const normalizedQuery = query.trim().toLowerCase();
  const candidateIds = candidates.map((u) => u.id);
  const followerCountRows = candidateIds.length
    ? await prisma.follow.groupBy({
        by: ['followingId'],
        where: { followingId: { in: candidateIds } },
        _count: { _all: true },
      })
    : [];
  const followerCounts = new Map(followerCountRows.map((row) => [row.followingId, row._count._all]));

  const bySearchRank = (a: (typeof candidates)[number], b: (typeof candidates)[number]) =>
    searchMatchRank(a, normalizedQuery) - searchMatchRank(b, normalizedQuery) ||
    (followerCounts.get(b.id) ?? 0) - (followerCounts.get(a.id) ?? 0) ||
    Number(b.isVerified ?? false) - Number(a.isVerified ?? false);

  if (!currentUserId || candidates.length === 0) {
    return candidates
      .sort(bySearchRank)
      .slice(0, 20)
      .map((u) => toPublicProfile(u));
  }

  const users = candidates;
  const userIds = users.map((u) => u.id);

  const [blockedUsers, followingRows, followerRows] = await Promise.all([
    prisma.block.findMany({
      where: {
        OR: [
          { blockerId: currentUserId, blockedId: { in: userIds } },
          { blockerId: { in: userIds }, blockedId: currentUserId },
        ],
      },
      select: { blockerId: true, blockedId: true },
    }),
    prisma.follow.findMany({
      where: { followerId: currentUserId, followingId: { in: userIds } },
      select: { followingId: true },
    }),
    prisma.follow.findMany({
      where: { followerId: { in: userIds }, followingId: currentUserId },
      select: { followerId: true },
    }),
  ]);

  const blockedIds = new Set(
    blockedUsers.map((block) => block.blockerId === currentUserId ? block.blockedId : block.blockerId)
  );
  const followingIds = new Set(followingRows.map((row) => row.followingId));
  const followerIds = new Set(followerRows.map((row) => row.followerId));

  return users
    .filter((user) => !blockedIds.has(user.id))
    .sort(bySearchRank)
    .slice(0, 20)
    .map((user) => {
      const friendStatus =
        user.id === currentUserId
          ? 'self'
          : followingIds.has(user.id) && followerIds.has(user.id)
            ? 'friends'
            : followingIds.has(user.id)
              ? 'following'
              : followerIds.has(user.id)
                ? 'follow_back'
                : 'none';

      return toPublicProfile(user, friendStatus);
    });
}
