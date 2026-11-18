import { PostBoostStatus } from '@prisma/client';
import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';
import { env } from '../config/env';
import { normalizeCountry } from '../utils/country';
import {
  BOOST_BUTTON_TEXTS, BOOST_CONTENT_TYPES, BOOST_COUNTRY_CODE, BOOST_DAILY_BUDGET, BOOST_DURATIONS, BOOST_ESTIMATE_FACTORS, BOOST_FIRST_BOOST_TRIAL, BOOST_MAX_ACTIVE_BOOSTS, BOOST_PAYMENT_DETAILS, BOOST_PLANS, BOOST_PURPOSES, BOOST_REPEAT_AFTER_HOURS, BOOST_V2_FIRST_BOOST_TRIAL,
  type BoostContentType, type BoostPurpose,
} from '../config/boost';

// Boost service (posts AND reels). The request/review flow mirrors the
// Blue Tick verification-request flow (userController
// .createVerificationRequest + adminController
// .reviewAdminVerificationRequest): one pending request at a time, an
// admin queue, a guarded pending -> approved/rejected transition with
// reviewedBy/reviewedAt, and an optional admin note. The difference:
// approval here also stamps the boost window (startsAt/endsAt) instead
// of flipping a flag on the user.
//
// A boost targets exactly one piece of content: contentType 'post' sets
// postId, contentType 'reel' sets reelId; the other id stays null.

const boostSelect = {
  id: true,
  contentType: true,
  postId: true,
  reelId: true,
  userId: true,
  purpose: true,
  planDays: true,
  amountPkr: true,
  dailyBudget: true,
  linkUrl: true,
  buttonText: true,
  paymentMethod: true,
  transactionId: true,
  screenshotUrl: true,
  status: true,
  adminNote: true,
  reviewedBy: true,
  reviewedAt: true,
  startsAt: true,
  endsAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

// An approved boost whose window has ended reads as "expired" everywhere
// without needing a background job to flip the stored status.
export function boostDisplayStatus(boost: { status: PostBoostStatus; endsAt: Date | null }): string {
  if (boost.status === PostBoostStatus.approved && boost.endsAt && boost.endsAt.getTime() <= Date.now()) {
    return 'expired';
  }
  return boost.status;
}

function toBoostDTO(boost: any) {
  return { ...boost, status: boostDisplayStatus(boost) };
}

// The Rs 79 first-boost trial applies while the user has never had an
// APPROVED boost (any past approved row counts, even one whose window
// has long ended — the stored status stays 'approved'; expiry is only
// computed on read).
async function hasEverHadApprovedBoost(userId: string): Promise<boolean> {
  const row = await prisma.postBoost.findFirst({
    where: { userId, status: PostBoostStatus.approved },
    select: { id: true },
  });
  return !!row;
}

export async function getBoostConfigForUser(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { country: true } });
  const eligible = normalizeCountry(user?.country) === BOOST_COUNTRY_CODE;
  const trialAvailable = !(await hasEverHadApprovedBoost(userId));
  return {
    eligible,
    country: normalizeCountry(user?.country) ?? null,
    plans: BOOST_PLANS,
    // When `available` is true, the plan with `planDays` costs
    // `amountPkr` for this user (first-boost trial) instead of its
    // regular price in `plans`.
    firstBoostTrial: {
      available: trialAvailable,
      planDays: BOOST_FIRST_BOOST_TRIAL.planDays,
      amountPkr: BOOST_FIRST_BOOST_TRIAL.amountPkr,
      dailyBudget: BOOST_V2_FIRST_BOOST_TRIAL.dailyBudget,
      days: BOOST_V2_FIRST_BOOST_TRIAL.days,
    },
    // Boost v2 pricing model (daily-budget slider + separate duration).
    budget: BOOST_DAILY_BUDGET,
    durations: BOOST_DURATIONS,
    buttonTexts: BOOST_BUTTON_TEXTS,
    estimateFactors: BOOST_ESTIMATE_FACTORS,
    purposes: BOOST_PURPOSES,
    paymentMethods: BOOST_PAYMENT_DETAILS.methods,
  };
}

export async function createBoostRequest(
  userId: string,
  input: {
    contentType?: unknown; postId?: unknown; reelId?: unknown; purpose?: unknown;
    planDays?: unknown; dailyBudget?: unknown; days?: unknown;
    linkUrl?: unknown; buttonText?: unknown;
    paymentMethod?: unknown; transactionId?: unknown; screenshotUrl?: unknown;
  }
) {
  const contentType = (typeof input.contentType === 'string' ? input.contentType : 'post') as BoostContentType;
  if (!BOOST_CONTENT_TYPES.includes(contentType)) {
    throw new ApiError(400, 'INVALID_CONTENT_TYPE', 'Choose a valid content type to boost.');
  }
  const targetId = contentType === 'reel'
    ? (typeof input.reelId === 'string' ? input.reelId : '')
    : (typeof input.postId === 'string' ? input.postId : '');
  if (!targetId) {
    throw new ApiError(400, 'TARGET_ID_REQUIRED', contentType === 'reel' ? 'Choose a reel to boost.' : 'Choose a post to boost.');
  }

  const purpose = BOOST_PURPOSES.find((p) => p.id === input.purpose);
  if (!purpose) throw new ApiError(400, 'INVALID_BOOST_PURPOSE', 'Choose why you are boosting (followers, views or business promotion).');

  // Boost v2 pricing (owner-approved design 2026-11-18): the user picks
  // a DAILY budget (Rs 100–1,000, steps of 50) and a duration (1/3/7/14
  // days) separately; the total is dailyBudget × days, derived here —
  // never taken from the client. The legacy fixed-plan path (planDays)
  // stays for older clients: it resolves to the plan's days and total,
  // with dailyBudget stored as null.
  const isV2 = typeof input.dailyBudget === 'number' || typeof input.days === 'number';
  let planDays: number;
  let dailyBudget: number | null = null;
  let baseAmountPkr: number;
  if (isV2) {
    const db = typeof input.dailyBudget === 'number' ? input.dailyBudget : NaN;
    if (!Number.isInteger(db) || db < BOOST_DAILY_BUDGET.min || db > BOOST_DAILY_BUDGET.max || db % BOOST_DAILY_BUDGET.step !== 0) {
      throw new ApiError(400, 'INVALID_BOOST_BUDGET', 'Choose a daily budget between Rs 100 and Rs 1,000.');
    }
    const days = typeof input.days === 'number' ? input.days : NaN;
    if (!BOOST_DURATIONS.includes(days)) {
      throw new ApiError(400, 'INVALID_BOOST_DURATION', 'Choose how many days the boost should run.');
    }
    dailyBudget = db;
    planDays = days;
    baseAmountPkr = db * days;
  } else {
    const plan = BOOST_PLANS.find((p) => p.days === input.planDays);
    if (!plan) throw new ApiError(400, 'INVALID_BOOST_PLAN', 'Choose a valid boost plan.');
    planDays = plan.days;
    baseAmountPkr = plan.amountPkr;
  }

  // Optional business link + button (Boost v2): only for the Business
  // Promotion purpose. The link shows on the boosted content as a
  // button with the chosen text; no link means no button. For other
  // purposes any link/button sent by the client is dropped.
  let linkUrl: string | null = null;
  let buttonText: string | null = null;
  if (purpose.id === 'business_promotion') {
    const rawLink = typeof input.linkUrl === 'string' ? input.linkUrl.trim() : '';
    if (rawLink) {
      if (rawLink.length > 500 || !/^https?:\/\/.+/i.test(rawLink)) {
        throw new ApiError(400, 'INVALID_BOOST_LINK', 'Enter a valid link starting with http:// or https://.');
      }
      const rawButton = typeof input.buttonText === 'string' ? input.buttonText : '';
      if (!(BOOST_BUTTON_TEXTS as readonly string[]).includes(rawButton)) {
        throw new ApiError(400, 'INVALID_BOOST_BUTTON', 'Choose a button text for your link.');
      }
      linkUrl = rawLink;
      buttonText = rawButton;
    }
  }

  const method = BOOST_PAYMENT_DETAILS.methods.find((m) => m.id === input.paymentMethod);
  if (!method) throw new ApiError(400, 'INVALID_PAYMENT_METHOD', 'Choose a valid payment method.');

  const screenshotUrl = typeof input.screenshotUrl === 'string' ? input.screenshotUrl.trim() : '';
  if (!screenshotUrl) throw new ApiError(400, 'SCREENSHOT_REQUIRED', 'Upload your payment screenshot first.');
  if (!screenshotUrl.startsWith(`${env.r2PublicUrl}/`)) {
    throw new ApiError(400, 'INVALID_SCREENSHOT_URL', 'Payment screenshot must be uploaded through the app.');
  }

  const transactionId = typeof input.transactionId === 'string' ? input.transactionId.trim() : '';
  if (transactionId.length > 100) {
    throw new ApiError(400, 'TRANSACTION_ID_TOO_LONG', 'Transaction ID must be 100 characters or fewer.');
  }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { country: true } });
  if (!user) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found.');
  if (normalizeCountry(user.country) !== BOOST_COUNTRY_CODE) {
    throw new ApiError(403, 'BOOST_COUNTRY_NOT_ELIGIBLE', 'Boosting is currently available in Pakistan only.');
  }

  // The target must exist and belong to the requester. Posts carry two
  // extra rules from the original design (public only; boost the
  // original, not a repost). Reels have no visibility/original concept,
  // so ownership is the only target rule for them.
  if (contentType === 'post') {
    const post = await prisma.post.findUnique({
      where: { id: targetId },
      select: { id: true, userId: true, visibility: true, originalPostId: true },
    });
    if (!post) throw new ApiError(404, 'POST_NOT_FOUND', 'Post not found.');
    if (post.userId !== userId) throw new ApiError(403, 'FORBIDDEN', 'You can only boost your own posts.');
    if (post.visibility !== 'public') throw new ApiError(400, 'POST_NOT_PUBLIC', 'Only public posts can be boosted.');
    if (post.originalPostId) {
      throw new ApiError(400, 'REPOST_NOT_BOOSTABLE', 'Shared posts cannot be boosted. Boost the original post instead.');
    }
  } else {
    const reel = await prisma.reel.findUnique({
      where: { id: targetId },
      select: { id: true, userId: true },
    });
    if (!reel) throw new ApiError(404, 'REEL_NOT_FOUND', 'Reel not found.');
    if (reel.userId !== userId) throw new ApiError(403, 'FORBIDDEN', 'You can only boost your own reels.');
  }

  // One pending or currently-active boost per content item (same guard
  // shape as the one-pending-verification-request rule).
  const existing = await prisma.postBoost.findFirst({
    where: {
      ...(contentType === 'reel' ? { reelId: targetId } : { postId: targetId }),
      OR: [
        { status: PostBoostStatus.pending },
        { status: PostBoostStatus.approved, endsAt: { gt: new Date() } },
      ],
    },
    select: { id: true, status: true },
  });
  if (existing) {
    throw new ApiError(409, 'BOOST_ALREADY_ACTIVE_OR_PENDING', 'This content already has a pending or active boost.');
  }

  // Active-boost limit (owner suggestion): at most
  // BOOST_MAX_ACTIVE_BOOSTS boosts live at once per user. "Live" is
  // the same computed-on-read test used everywhere else — stored
  // status approved and now inside [startsAt, endsAt). Pending
  // requests do not count. Note the per-content guard above only ever
  // matches pending or live rows, so a FINISHED boost (approved but
  // past endsAt, or rejected) never blocks re-boosting the same
  // content — re-boost is just a new request here.
  const limitNow = new Date();
  const activeBoostCount = await prisma.postBoost.count({
    where: {
      userId,
      status: PostBoostStatus.approved,
      startsAt: { lte: limitNow },
      endsAt: { gt: limitNow },
    },
  });
  if (activeBoostCount >= BOOST_MAX_ACTIVE_BOOSTS) {
    throw new ApiError(409, 'BOOST_LIMIT_REACHED', `You already have ${BOOST_MAX_ACTIVE_BOOSTS} boosts running. Wait for one to finish before boosting more.`);
  }

  // Amount is ALWAYS derived here, never taken from the client: the
  // plan's price (legacy) or dailyBudget × days (v2), except a
  // first-ever boost at the smallest size (1 day / Rs 100 plan, or
  // Rs 100/day × 1 day in v2) costs the Rs 79 trial price while the
  // user has never had an approved boost.
  let amountPkr = baseAmountPkr;
  if (!(await hasEverHadApprovedBoost(userId))) {
    if (isV2 && dailyBudget === BOOST_V2_FIRST_BOOST_TRIAL.dailyBudget && planDays === BOOST_V2_FIRST_BOOST_TRIAL.days) {
      amountPkr = BOOST_V2_FIRST_BOOST_TRIAL.amountPkr;
    } else if (!isV2 && planDays === BOOST_FIRST_BOOST_TRIAL.planDays) {
      amountPkr = BOOST_FIRST_BOOST_TRIAL.amountPkr;
    }
  }

  const boost = await prisma.postBoost.create({
    data: {
      contentType,
      postId: contentType === 'post' ? targetId : null,
      reelId: contentType === 'reel' ? targetId : null,
      userId,
      purpose: purpose.id as BoostPurpose,
      planDays,
      amountPkr,
      dailyBudget,
      linkUrl,
      buttonText,
      paymentMethod: method.id,
      transactionId: transactionId || null,
      screenshotUrl,
    },
    select: boostSelect,
  });
  return toBoostDTO(boost);
}

// Real results for one of the owner's boosts, counted over the boost's
// run window [startsAt, endsAt] — or [startsAt, now] while it is still
// running: content views recorded inside the window (post_views /
// reel_views rows, both carry a created_at timestamp) plus new
// followers gained inside the window (follows.created_at where
// followingId = the boost owner). Only approved boosts have a window;
// pending and rejected boosts return null. Counts are single indexed
// lookups (post_views.post_id, reel_views.reel_id, follows.following_id)
// and run only for the requesting user's own boosts.
async function getBoostResults(
  boost: {
    status: PostBoostStatus; contentType: string;
    postId: string | null; reelId: string | null;
    startsAt: Date | null; endsAt: Date | null;
  },
  userId: string,
): Promise<{ views: number | null; followers: number } | null> {
  if (boost.status !== PostBoostStatus.approved || !boost.startsAt) return null;
  const window = { gte: boost.startsAt, lt: boost.endsAt ?? new Date() };
  const [views, followers] = await Promise.all([
    boost.contentType === 'reel'
      ? (boost.reelId
          ? prisma.reelView.count({ where: { reelId: boost.reelId, createdAt: window } })
          : Promise.resolve<number | null>(null))
      : (boost.postId
          ? prisma.postView.count({ where: { postId: boost.postId, createdAt: window } })
          : Promise.resolve<number | null>(null)),
    prisma.follow.count({ where: { followingId: userId, createdAt: window } }),
  ]);
  return { views, followers };
}

export async function getMyBoosts(userId: string) {
  const boosts = await prisma.postBoost.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      ...boostSelect,
      post: { select: { id: true, content: true, imageUrl: true, createdAt: true } },
      reel: { select: { id: true, caption: true, thumbnailUrl: true, videoUrl: true, createdAt: true } },
    },
  });
  return Promise.all(boosts.map(async (boost) => ({
    ...toBoostDTO(boost),
    results: await getBoostResults(boost, userId),
  })));
}

// Post ids with a boost that is live right now (approved and inside its
// window), soonest-expiring first. Used by the post feed (all active
// boosts) and by post/profile reads (a specific set of posts).
export async function getActiveBoostPostIds(postIds?: string[]): Promise<Set<string>> {
  const now = new Date();
  const rows = await prisma.postBoost.findMany({
    where: {
      contentType: 'post',
      status: PostBoostStatus.approved,
      startsAt: { lte: now },
      endsAt: { gt: now },
      ...(postIds ? { postId: { in: postIds } } : {}),
    },
    select: { postId: true },
    orderBy: { endsAt: 'asc' },
  });
  return new Set(rows.map((r) => r.postId).filter((id): id is string => !!id));
}

// Reel ids with a boost that is live right now, soonest-expiring first.
// Same contract as getActiveBoostPostIds, for the reels feed and the
// single-reel / profile-reels reads.
export async function getActiveBoostReelIds(reelIds?: string[]): Promise<Set<string>> {
  const now = new Date();
  const rows = await prisma.postBoost.findMany({
    where: {
      contentType: 'reel',
      status: PostBoostStatus.approved,
      startsAt: { lte: now },
      endsAt: { gt: now },
      ...(reelIds ? { reelId: { in: reelIds } } : {}),
    },
    select: { reelId: true },
    orderBy: { endsAt: 'asc' },
  });
  return new Set(rows.map((r) => r.reelId).filter((id): id is string => !!id));
}

// ---- Boost v2 read helpers (owner-approved design 2026-11-18) ----

export interface ActiveBoostInfo {
  purpose: string;
  linkUrl: string | null;
  buttonText: string | null;
}

// Live-boost details for a set of posts/reels, keyed by content id. The
// feeds and single-content reads use this to attach the boost button:
// Followers Gain boosts carry a Follow button, Business Promotion
// boosts with a link carry that link as a button, Views Gain boosts
// carry no button (see boostButtonFor).
export async function getActiveBoostPostInfo(postIds: string[]): Promise<Map<string, ActiveBoostInfo>> {
  const map = new Map<string, ActiveBoostInfo>();
  if (postIds.length === 0) return map;
  const now = new Date();
  const rows = await prisma.postBoost.findMany({
    where: {
      contentType: 'post',
      status: PostBoostStatus.approved,
      startsAt: { lte: now },
      endsAt: { gt: now },
      postId: { in: postIds },
    },
    select: { postId: true, purpose: true, linkUrl: true, buttonText: true },
    orderBy: { endsAt: 'asc' },
  });
  for (const r of rows) {
    if (r.postId && !map.has(r.postId)) {
      map.set(r.postId, { purpose: r.purpose, linkUrl: r.linkUrl, buttonText: r.buttonText });
    }
  }
  return map;
}

export async function getActiveBoostReelInfo(reelIds: string[]): Promise<Map<string, ActiveBoostInfo>> {
  const map = new Map<string, ActiveBoostInfo>();
  if (reelIds.length === 0) return map;
  const now = new Date();
  const rows = await prisma.postBoost.findMany({
    where: {
      contentType: 'reel',
      status: PostBoostStatus.approved,
      startsAt: { lte: now },
      endsAt: { gt: now },
      reelId: { in: reelIds },
    },
    select: { reelId: true, purpose: true, linkUrl: true, buttonText: true },
    orderBy: { endsAt: 'asc' },
  });
  for (const r of rows) {
    if (r.reelId && !map.has(r.reelId)) {
      map.set(r.reelId, { purpose: r.purpose, linkUrl: r.linkUrl, buttonText: r.buttonText });
    }
  }
  return map;
}

// The button a boosted item shows in the feed, derived from its boost:
// Follow for Followers Gain, the user's link (with its chosen text) for
// Business Promotion with a link, and nothing otherwise.
export function boostButtonFor(
  info?: ActiveBoostInfo | null,
): { type: 'follow' } | { type: 'link'; url: string; text: string } | null {
  if (!info) return null;
  if (info.purpose === 'followers_gain') return { type: 'follow' };
  if (info.purpose === 'business_promotion' && info.linkUrl) {
    return { type: 'link', url: info.linkUrl, text: info.buttonText || 'Learn More' };
  }
  return null;
}

// Of `postIds`, the ones this viewer saw at least
// BOOST_REPEAT_AFTER_HOURS ago. The feeds use this to let a BOOSTED
// item re-appear through its boost slot once the earlier view is old;
// a fresh view (< 6h) still blocks the slot, and normal (non-boosted)
// content is never affected — its seen rule is unchanged.
export async function getStaleViewedPostIds(viewerId: string, postIds: string[]): Promise<Set<string>> {
  if (!viewerId || postIds.length === 0) return new Set();
  const cutoff = new Date(Date.now() - BOOST_REPEAT_AFTER_HOURS * 60 * 60 * 1000);
  const rows = await prisma.postView.findMany({
    where: { viewerId, postId: { in: postIds }, createdAt: { lt: cutoff } },
    select: { postId: true },
  }).catch(() => [] as Array<{ postId: string }>);
  return new Set(rows.map((r) => r.postId));
}

export async function getStaleViewedReelIds(viewerId: string, reelIds: string[]): Promise<Set<string>> {
  if (!viewerId || reelIds.length === 0) return new Set();
  const cutoff = new Date(Date.now() - BOOST_REPEAT_AFTER_HOURS * 60 * 60 * 1000);
  const rows = await prisma.reelView.findMany({
    where: { viewerId, reelId: { in: reelIds }, createdAt: { lt: cutoff } },
    select: { reelId: true },
  }).catch(() => [] as Array<{ reelId: string }>);
  return new Set(rows.map((r) => r.reelId));
}
