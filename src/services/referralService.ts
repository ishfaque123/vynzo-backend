import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';
import { toggleFollow } from './followService';

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
      encodeURIComponent('username=' + username)
    : null;

  return { count, referralLink };
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

    return { accepted: true, referralId: result.id, referrerUsername: referrer.username };
  } catch (err: any) {
    if (err?.code === 'P2002') {
      return { accepted: false, reason: 'REFERRAL_ALREADY_CLAIMED' as const };
    }
    throw err;
  }
}
