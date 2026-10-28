import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';
import { toggleFollow } from './followService';

// Referrals are the monetization gate only (25 referrals unlock earning).
// Referral claims themselves no longer pay (AdMob approval fix, owner order 2026-10-28):
// previously earned referral credit stays untouched.

function extractReferralUsername(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  const params = new URLSearchParams(value.includes('://') ? new URL(value).search : value);
  const username = params.get('username')?.trim();
  if (username) return username;
  const match = value.match(/(?:^|[?&])username=([^&]+)/i);
  return match ? decodeURIComponent(match[1]).trim() : null;
}

async function getOfficialUser() {
  const configured = process.env.OFFICIAL_FRIANZO_USERNAME?.trim();
  if (configured) {
    return prisma.user.findUnique({ where: { username: configured } });
  }
  return prisma.user.findFirst({ where: { role: 'official', accountStatus: 'active' } });
}

export async function getMyReferralInfo(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { username: true },
  });
  if (!user) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found.');

  const count = await prisma.referral.count({ where: { referrerId: userId } });
  const username = user.username ?? '';
  const referralLink = username
    ? 'https://play.google.com/store/apps/details?id=com.frianzo.app&referrer=' +
      encodeURIComponent(`username=${username}`)
    : null;

  return { count, referralLink };
}

export type LeaderboardCategory = 'followers' | 'likers' | 'commenters' | 'referrers';

export async function getLeaderboard(category: LeaderboardCategory, limit = 10) {
  const safeLimit = Math.min(Math.max(Math.floor(limit) || 10, 1), 50);
  const counts = new Map<string, number>();
  const add = (id: string, n: number) => counts.set(id, (counts.get(id) ?? 0) + n);

  if (category === 'followers') {
    const rows = await prisma.follow.groupBy({
      by: ['followingId'],
      _count: { followingId: true },
      orderBy: { _count: { followingId: 'desc' } },
      take: safeLimit,
    });
    rows.forEach((r) => add(r.followingId, r._count.followingId));
  } else if (category === 'likers') {
    const [postLikes, reelLikes] = await Promise.all([
      prisma.like.groupBy({ by: ['userId'], _count: { userId: true }, orderBy: { _count: { userId: 'desc' } }, take: safeLimit }),
      prisma.reelLike.groupBy({ by: ['userId'], _count: { userId: true }, orderBy: { _count: { userId: 'desc' } }, take: safeLimit }),
    ]);
    postLikes.forEach((r) => add(r.userId, r._count.userId));
    reelLikes.forEach((r) => add(r.userId, r._count.userId));
  } else if (category === 'commenters') {
    const [comments, reelComments] = await Promise.all([
      prisma.comment.groupBy({ by: ['userId'], _count: { userId: true }, orderBy: { _count: { userId: 'desc' } }, take: safeLimit }),
      prisma.reelComment.groupBy({ by: ['userId'], _count: { userId: true }, orderBy: { _count: { userId: 'desc' } }, take: safeLimit }),
    ]);
    comments.forEach((r) => add(r.userId, r._count.userId));
    reelComments.forEach((r) => add(r.userId, r._count.userId));
  } else {
    const rows = await prisma.referral.groupBy({
      by: ['referrerId'],
      _count: { referrerId: true },
      orderBy: { _count: { referrerId: 'desc' } },
      take: safeLimit,
    });
    rows.forEach((r) => add(r.referrerId, r._count.referrerId));
  }

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, safeLimit);
  if (ranked.length === 0) return [];
  const users = await prisma.user.findMany({
    where: { id: { in: ranked.map(([id]) => id) } },
    select: { id: true, username: true, displayName: true, profilePictureUrl: true, isVerified: true },
  });
  const byId = new Map(users.map((u) => [u.id, u]));
  return ranked
    .map(([id, count], i) => {
      const u = byId.get(id);
      if (!u?.username) return null;
      return {
        rank: i + 1,
        username: u.username,
        displayName: u.displayName,
        avatar: u.profilePictureUrl,
        isVerified: u.isVerified,
        count,
      };
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);
}

export async function claimReferral(
  referredUserId: string,
  rawInstallReferrer: string,
  deviceFingerprint: string,
) {
  const username = extractReferralUsername(rawInstallReferrer);
  if (!username) throw new ApiError(400, 'INVALID_REFERRAL', 'Referral information is invalid.');

  if (!deviceFingerprint || deviceFingerprint.length < 32 || deviceFingerprint.length > 128) {
    throw new ApiError(400, 'INVALID_DEVICE_FINGERPRINT', 'Device verification data is invalid.');
  }

  const referredUser = await prisma.user.findUnique({
    where: { id: referredUserId },
    select: { id: true, username: true },
  });
  if (!referredUser) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found.');

  const referrer = await prisma.user.findUnique({
    where: { username },
    select: { id: true, username: true, accountStatus: true },
  });
  if (!referrer || referrer.accountStatus !== 'active') {
    throw new ApiError(400, 'REFERRER_NOT_FOUND', 'Referral user was not found.');
  }
  if (referrer.id === referredUserId) {
    throw new ApiError(400, 'SELF_REFERRAL', 'You cannot use your own referral link.');
  }

  const existingAccountReferral = await prisma.referral.findUnique({
    where: { referredUserId },
    select: { id: true },
  });
  if (existingAccountReferral) return { accepted: false, reason: 'ACCOUNT_ALREADY_REFERRED' as const };

  const existingDeviceReferral = await prisma.referral.findUnique({
    where: { deviceFingerprint },
    select: { id: true },
  });
  if (existingDeviceReferral) return { accepted: false, reason: 'DEVICE_ALREADY_REFERRED' as const };

  try {
    const result = await prisma.$transaction(async (tx) => {
      const referral = await tx.referral.create({
        data: {
          referrerId: referrer.id,
          referredUserId,
          deviceFingerprint,
          installReferrer: rawInstallReferrer.slice(0, 1000),
        },
        select: { id: true },
      });

      return referral;
    });

    // Follow actions are idempotent only when the target is not already followed.
    // Read first so claiming a referral can never accidentally unfollow an existing follow.
    const ensureFollow = async (targetId: string) => {
      if (targetId === referredUserId) return;
      const existing = await prisma.follow.findUnique({
        where: { followerId_followingId: { followerId: referredUserId, followingId: targetId } },
      });
      if (!existing) await toggleFollow(referredUserId, targetId);
    };

    await ensureFollow(referrer.id);
    const official = await getOfficialUser();
    if (official && official.id !== referredUserId && official.id !== referrer.id) {
      await ensureFollow(official.id);
    }

    // No referral payout: the referrer earns nothing for this claim.
    const earned = 0;

    return { accepted: true, referralId: result.id, referrerUsername: referrer.username, earned };
  } catch (err: any) {
    if (err?.code === 'P2002') {
      return { accepted: false, reason: 'REFERRAL_ALREADY_CLAIMED' as const };
    }
    throw err;
  }
}
