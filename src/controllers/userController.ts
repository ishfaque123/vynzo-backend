import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../utils/ApiResponse';
import { ApiError } from '../middleware/errorHandler';
import { profileSetupSchema, profileUpdateSchema } from '../utils/validators/profileValidators';
import { completeProfile, updateProfile, getPublicProfileByUsername, toPrivateProfile, searchUsers } from '../services/userService';
import { reportUser } from '../services/userReportService';
import { prisma } from '../config/prisma';
import { uploadToR2, deleteFromR2 } from '../config/r2';
import { z } from 'zod';
import { claimReferral, getMyReferralInfo, getLeaderboard, LeaderboardCategory } from '../services/referralService';
import { getDashboardStats } from '../services/dashboardService';

export async function getMyProfile(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    sendSuccess(res, { user: toPrivateProfile(user) });
  } catch (err) { next(err); }
}

export async function getPublicProfile(req: Request, res: Response, next: NextFunction) {
  try {
    const profile = await getPublicProfileByUsername(req.params.username, req.user?.id);
    sendSuccess(res, { user: profile });
  } catch (err) { next(err); }
}

export async function postProfileSetup(req: Request, res: Response, next: NextFunction) {
  try {
    const existing = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (existing?.profileCompleted) {
      throw new ApiError(403, 'PROFILE_ALREADY_COMPLETED', 'Profile setup already completed. Use Edit Profile to make changes.');
    }
    const data = profileSetupSchema.parse(req.body);
    // Auto-detect country from IP (Cloudflare header) — no longer asked in signup form
    const ipCountry = req.headers['cf-ipcountry'];
    const autoCountry = typeof ipCountry === 'string' && /^[A-Z]{2}$/.test(ipCountry) ? ipCountry : null;
    const user = await completeProfile(req.user!.id, { ...data, country: autoCountry || data.country || null });
    sendSuccess(res, { user: toPrivateProfile(user) });
  } catch (err) { next(err); }
}

export async function patchMyProfile(req: Request, res: Response, next: NextFunction) {
  try {
    const data = profileUpdateSchema.parse(req.body);
    const user = await updateProfile(req.user!.id, data as any);
    sendSuccess(res, { user: toPrivateProfile(user) });
  } catch (err) { next(err); }
}

export async function searchUsersHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const query = (req.query.q as string) || '';
    const users = query.length > 0 ? await searchUsers(query, req.user?.id) : [];
    sendSuccess(res, { users });
  } catch (err) { next(err); }
}

export async function getMyReferral(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await getMyReferralInfo(req.user!.id);
    sendSuccess(res, data);
  } catch (err) { next(err); }
}

export async function claimMyReferral(req: Request, res: Response, next: NextFunction) {
  try {
    const rawInstallReferrer = typeof req.body?.installReferrer === 'string' ? req.body.installReferrer : '';
    const deviceFingerprint = typeof req.body?.deviceFingerprint === 'string' ? req.body.deviceFingerprint : '';
    const data = await claimReferral(req.user!.id, rawInstallReferrer, deviceFingerprint);
    sendSuccess(res, data);
  } catch (err) { next(err); }
}

export async function getReferralLeaderboardHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const limit = parseInt(req.query.limit as string, 10);
    const rawCategory = (req.query.category as string) || 'referrers';
    const valid: LeaderboardCategory[] = ['followers', 'likers', 'commenters', 'referrers'];
    const category: LeaderboardCategory = valid.includes(rawCategory as LeaderboardCategory)
      ? (rawCategory as LeaderboardCategory)
      : 'referrers';
    const data = await getLeaderboard(category, Number.isFinite(limit) ? limit : 10);
    sendSuccess(res, { leaderboard: data, category });
  } catch (err) { next(err); }
}

export async function getMyDashboard(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { walletBalance: true, monetizationForced: true },
    });
    if (!user) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found.');

    const referralInfo = await getMyReferralInfo(req.user!.id);
    const referrals = referralInfo.count;
    const requiredReferrals = 25;
    const daysParam = parseInt(req.query.days as string, 10);
    const days = [7, 30, 90].includes(daysParam) ? daysParam : 30;
    const stats = await getDashboardStats(req.user!.id, days);

    // Weekly goals (Mon-Sun)
    const weekStart = new Date();
    weekStart.setHours(0, 0, 0, 0);
    weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
    const [weekPosts, weekReels, weekStories] = await Promise.all([
      prisma.post.count({ where: { userId: req.user!.id, originalPostId: null, createdAt: { gte: weekStart } } }),
      prisma.reel.count({ where: { userId: req.user!.id, createdAt: { gte: weekStart } } }),
      prisma.status.count({ where: { userId: req.user!.id, createdAt: { gte: weekStart } } }).catch(() => 0),
    ]);

    const goals = {
      posts: { current: weekPosts, target: 7 },
      reels: { current: weekReels, target: 7 },
      stories: { current: weekStories, target: 14 },
    };
    const allGoalsMet = weekPosts >= 7 && weekReels >= 7 && weekStories >= 14;
    let newAchievement = null;
    if (allGoalsMet) {
      try {
        const { awardAchievement } = await import('../services/achievementService');
        newAchievement = await awardAchievement(req.user!.id, 'weekly_champion');
      } catch {}
    }

    sendSuccess(res, {
      earnings: user.walletBalance,
      goals,
      allGoalsMet,
      newAchievement: newAchievement ? { key: newAchievement.key, name: newAchievement.name } : null,
      monetization: {
        status: (user.monetizationForced || referrals >= requiredReferrals) ? 'eligible' : 'locked',
        referrals,
        requiredReferrals,
        progress: Math.min(100, Math.round((referrals / requiredReferrals) * 100)),
        referralLink: referralInfo.referralLink,
        earningPerReferral: 0,
        freeReferrals: requiredReferrals,
      },
      stats,
    });
  } catch (err) { next(err); }
}

export async function deleteMyAccount(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { profilePictureUrl: true, coverPhotoUrl: true },
    });
    if (!user) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found.');

    const [posts, reels, statuses, messages] = await Promise.all([
      prisma.post.findMany({ where: { userId }, select: { imageUrl: true } }),
      prisma.reel.findMany({ where: { userId }, select: { videoUrl: true, thumbnailUrl: true } }),
      prisma.status.findMany({ where: { userId }, select: { mediaUrl: true } }),
      prisma.message.findMany({ where: { senderId: userId }, select: { mediaUrl: true } }),
    ]);

    const mediaUrls = [
      user.profilePictureUrl,
      user.coverPhotoUrl,
      ...posts.map((p) => p.imageUrl),
      ...reels.flatMap((r) => [r.videoUrl, r.thumbnailUrl]),
      ...statuses.map((s) => s.mediaUrl),
      ...messages.map((m) => m.mediaUrl),
    ].filter((url): url is string => Boolean(url));

    const results = await Promise.allSettled(mediaUrls.map((url) => deleteFromR2(url)));
    const failed = results.filter((result) => result.status === 'rejected');
    if (failed.length) {
      console.error(`Failed to delete ${failed.length} account media file(s) from R2; account deletion aborted.`);
      throw new ApiError(500, 'MEDIA_CLEANUP_FAILED', 'Could not remove all account media. Please try again.');
    }

    await prisma.user.delete({ where: { id: userId } });
    res.clearCookie('vynzo_token', { secure: true, sameSite: 'none' as const, domain: '.frianzo.online' });
    sendSuccess(res, { deleted: true });
  } catch (err) { next(err); }
}

const reportUserSchema = z.object({
  reason: z.enum(['spam', 'harassment', 'hate_speech', 'violence', 'nudity', 'misinformation', 'other']).default('other'),
  details: z.string().max(500).optional(),
});

export async function reportUserHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { reason, details } = reportUserSchema.parse(req.body ?? {});
    const result = await reportUser(req.user!.id, req.params.userId, reason, details);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function updateAvatarHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.file) throw new ApiError(400, 'NO_FILE', 'No image uploaded.');
    const url = await uploadToR2(req.file.buffer, req.file.mimetype, 'avatars');
    const user = await updateProfile(req.user!.id, { profilePictureUrl: url } as any);
    sendSuccess(res, { user: toPrivateProfile(user) });
  } catch (err) { next(err); }
}

export async function updateCoverHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.file) throw new ApiError(400, 'NO_FILE', 'No image uploaded.');
    const url = await uploadToR2(req.file.buffer, req.file.mimetype, 'covers');
    const user = await updateProfile(req.user!.id, { coverPhotoUrl: url } as any);
    sendSuccess(res, { user: toPrivateProfile(user) });
  } catch (err) { next(err); }
}


async function getVerificationEligibility(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { createdAt: true, isVerified: true, profilePictureUrl: true, bio: true },
  });
  if (!user) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found.');

  const accountAgeDays = Math.floor((Date.now() - user.createdAt.getTime()) / (1000 * 60 * 60 * 24));
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const [posts, followers, referrals, strikes, removals] = await Promise.all([
    prisma.post.count({ where: { userId, originalPostId: null } }),
    prisma.follow.count({ where: { followingId: userId } }),
    prisma.referral.count({ where: { referrerId: userId } }).catch(() => 0),
    prisma.chatAbuseStrike.count({ where: { userId, createdAt: { gte: ninetyDaysAgo } } }).catch(() => 0),
    prisma.notification.count({
      where: {
        userId,
        type: { in: ['comment_removed', 'post_removed', 'reel_removed'] },
        createdAt: { gte: ninetyDaysAgo },
      },
    }).catch(() => 0),
  ]);

  const hasPhoto = !!user.profilePictureUrl;
  const hasBio = !!user.bio?.trim();
  const violations = strikes + removals;

  const requirements = {
    referrals: { current: referrals, required: 25, met: referrals >= 25 },
    followers: { current: followers, required: 100, met: followers >= 100 },
    accountAge: { current: accountAgeDays, required: 30, met: accountAgeDays >= 30 },
    posts: { current: posts, required: 5, met: posts >= 5 },
    profile: { current: hasPhoto && hasBio ? 'Complete' : 'Incomplete', required: 'Photo + Bio', met: hasPhoto && hasBio },
    cleanRecord: { current: violations === 0 ? 'Clean' : `${violations} violation(s)`, required: 'No violations (90d)', met: violations === 0 },
  };

  return {
    eligible: Object.values(requirements).every((item) => item.met),
    requirements,
    isVerified: user.isVerified,
  };
}

export async function createVerificationRequest(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';

    if (!reason) throw new ApiError(400, 'VERIFICATION_REASON_REQUIRED', 'Please tell us why you are requesting verification.');
    if (reason.length > 1000) throw new ApiError(400, 'VERIFICATION_REASON_TOO_LONG', 'Verification request details must be 1000 characters or fewer.');

    const eligibility = await getVerificationEligibility(userId);
    if (!eligibility.eligible) {
      throw new ApiError(403, 'VERIFICATION_REQUIREMENTS_NOT_MET', 'Your account does not meet all verification requirements yet.');
    }
    if (eligibility.isVerified) throw new ApiError(400, 'ALREADY_VERIFIED', 'Your account is already verified.');

    const pending = await prisma.verificationRequest.findFirst({
      where: { userId, status: 'pending' },
      select: { id: true, status: true, createdAt: true },
    });
    if (pending) throw new ApiError(409, 'VERIFICATION_REQUEST_PENDING', 'Your verification request is already pending.');

    const request = await prisma.verificationRequest.create({
      data: { userId, reason },
      select: { id: true, status: true, reason: true, adminNote: true, reviewedAt: true, createdAt: true },
    });

    return sendSuccess(res, { request, eligibility });
  } catch (err) {
    next(err);
  }
}

export async function getMyVerificationRequest(req: Request, res: Response, next: NextFunction) {
  try {
    const [request, eligibility] = await Promise.all([
      prisma.verificationRequest.findFirst({
        where: { userId: req.user!.id },
        orderBy: { createdAt: 'desc' },
        select: { id: true, status: true, reason: true, adminNote: true, reviewedAt: true, createdAt: true },
      }),
      getVerificationEligibility(req.user!.id),
    ]);

    return sendSuccess(res, { request, eligibility });
  } catch (err) {
    next(err);
  }
}


export async function getMyAchievements(req: Request, res: Response, next: NextFunction) {
  try {
    const { getUserAchievements } = await import('../services/achievementService');
    const achievements = await getUserAchievements(req.user!.id);
    sendSuccess(res, { achievements });
  } catch (err) {
    next(err);
  }
}

export const AVAILABLE_INTERESTS = ['comedy', 'music', 'dance', 'sports', 'food', 'travel', 'fashion', 'tech', 'education', 'gaming', 'pets', 'art'] as const;

export async function getInterests(req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, { interests: AVAILABLE_INTERESTS });
  } catch (err) { next(err); }
}

export async function updateMyInterests(req: Request, res: Response, next: NextFunction) {
  try {
    const { interests } = req.body;
    if (!Array.isArray(interests)) throw new ApiError(400, 'INVALID_INTERESTS', 'Interests must be an array.');
    const valid = interests.filter((i: any) => typeof i === 'string' && (AVAILABLE_INTERESTS as readonly string[]).includes(i));
    await prisma.user.update({ where: { id: req.user!.id }, data: { interests: valid } });
    sendSuccess(res, { interests: valid });
  } catch (err) { next(err); }
}

export async function markNotInterested(req: Request, res: Response, next: NextFunction) {
  try {
    const { type, value } = req.body; // type: 'category' | 'creator' | 'interested_category', value: string
    if (!['category', 'creator', 'interested_category'].includes(type) || typeof value !== 'string') {
      throw new ApiError(400, 'INVALID_FEEDBACK', 'Invalid feedback type.');
    }
    const user = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { notInterested: true } });
    const current = Array.isArray(user?.notInterested) ? (user.notInterested as any[]) : [];
    // Remove existing entry for same type+value, then add
    const filtered = current.filter((x: any) => !(x.type === type && x.value === value));
    filtered.push({ type, value, at: new Date().toISOString() });
    // Keep max 100 entries
    const trimmed = filtered.slice(-100);
    await prisma.user.update({ where: { id: req.user!.id }, data: { notInterested: trimmed } });
    sendSuccess(res, { ok: true });
  } catch (err) { next(err); }
}

export async function getMyStrikes(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user!.id;
    const [strikes, removals] = await Promise.all([
      prisma.chatAbuseStrike.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, severity: true, reason: true, action: true, createdAt: true },
      }).catch(() => []),
      prisma.notification.findMany({
        where: {
          userId,
          type: { in: ['comment_removed', 'post_removed', 'reel_removed'] },
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, type: true, detail: true, createdAt: true },
      }).catch(() => []),
    ]);
    sendSuccess(res, { strikes, removals, total: strikes.length + removals.length });
  } catch (err) {
    next(err);
  }
}

export async function getUserAchievementsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { getUserAchievements } = await import('../services/achievementService');
    const user = await prisma.user.findUnique({ where: { username: req.params.username }, select: { id: true } });
    if (!user) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found.');
    const achievements = await getUserAchievements(user.id);
    sendSuccess(res, { achievements });
  } catch (err) {
    next(err);
  }
}
