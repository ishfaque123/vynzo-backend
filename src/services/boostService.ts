import { PostBoostStatus } from '@prisma/client';
import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';
import { env } from '../config/env';
import { normalizeCountry } from '../utils/country';
import {
  BOOST_BUTTON_TEXTS, BOOST_BUTTON_TEXT_MAX_LENGTH, BOOST_CONTENT_TYPES, BOOST_COUNTRY_CODE, BOOST_DAILY_BUDGET, BOOST_DURATIONS, BOOST_ESTIMATE_FACTORS, BOOST_FIRST_BOOST_TRIAL, BOOST_MAX_ACTIVE_BOOSTS, BOOST_PAYMENT_DETAILS, BOOST_PLANS, BOOST_PURPOSES, BOOST_REPEAT_AFTER_HOURS, BOOST_V2_FIRST_BOOST_TRIAL,
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
  linkClicks: true,
  clickCap: true,
  createdAt: true,
  updatedAt: true,
} as const;

// Click cap bounds (owner order 2026-11-25): a Clicks boost MUST end
// after 1–100,000 link clicks — the cap is required, never optional.
// Legacy Business Promotion rows keep whatever cap they had (or none).
const BOOST_CLICK_CAP_MIN = 1;
const BOOST_CLICK_CAP_MAX = 100000;

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
    linkUrl?: unknown; buttonText?: unknown; clickCap?: unknown;
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
  if (!purpose) throw new ApiError(400, 'INVALID_BOOST_PURPOSE', 'Choose why you are boosting (followers, views or clicks).');

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

  // Clicks link + button (owner decision 2026-11-25) + OPTIONAL click
  // target (owner order 2026-11-26 09:41 — reversed the earlier
  // required-target decision: "Target nahi likhna hoga — clicks jitne
  // aayein"). A Clicks boost REQUIRES a link and a button text. The
  // link shows on the boosted content as a button with the chosen
  // text. The click target, when set, ends the boost automatically
  // once it reaches that many link clicks; when blank, the boost
  // runs its full days and only the days end it. Without a link there
  // is no button, so a Clicks boost without one is just a Views boost
  // under another name — that is why link + button are required, not
  // optional. For other purposes any link/button/cap sent by the
  // client is dropped.
  let linkUrl: string | null = null;
  let buttonText: string | null = null;
  let clickCap: number | null = null;
  if (purpose.id === 'clicks') {
    const rawLink = typeof input.linkUrl === 'string' ? input.linkUrl.trim() : '';
    if (!rawLink) {
      throw new ApiError(400, 'INVALID_BOOST_LINK', 'Add a link — a Clicks boost needs a link to send people to.');
    }
    if (rawLink.length > 500 || !/^https?:\/\/.+/i.test(rawLink)) {
      throw new ApiError(400, 'INVALID_BOOST_LINK', 'Enter a valid link starting with http:// or https://.');
    }
    // Button text: one of the 3 presets, or the user's own words
    // (owner order 2026-11-26 01:41). Custom text is trimmed and
    // capped at BOOST_BUTTON_TEXT_MAX_LENGTH (30 — the DB column
    // width, buttonText VarChar(30)).
    const rawButton = typeof input.buttonText === 'string' ? input.buttonText.trim() : '';
    const isPresetButton = (BOOST_BUTTON_TEXTS as readonly string[]).includes(rawButton);
    if (!rawButton) {
      throw new ApiError(400, 'INVALID_BOOST_BUTTON', 'Choose a button text for your link.');
    }
    if (!isPresetButton && rawButton.length > BOOST_BUTTON_TEXT_MAX_LENGTH) {
      throw new ApiError(400, 'INVALID_BOOST_BUTTON', 'Button words must be 30 letters or fewer.');
    }
    linkUrl = rawLink;
    buttonText = rawButton;
    // Optional click target (owner order 2026-11-26 09:41): when set,
    // the boost ends automatically once it reaches this many link
    // clicks (recordBoostLinkClick flips the stored status to
    // 'expired' and stamps endsAt = now). When blank, clickCap stays
    // null and the boost runs its full days — the hard stop applies
    // only when a target is set. A target that IS sent must be a
    // whole number from 1 to 100,000.
    if (input.clickCap !== null && input.clickCap !== undefined && input.clickCap !== '') {
      const cap = typeof input.clickCap === 'number' ? input.clickCap : Number(input.clickCap);
      if (!Number.isInteger(cap) || cap < BOOST_CLICK_CAP_MIN || cap > BOOST_CLICK_CAP_MAX) {
        throw new ApiError(400, 'INVALID_BOOST_CLICK_CAP', 'Choose how many clicks the boost should stop after (1 to 100,000).');
      }
      clickCap = cap;
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
      clickCap,
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
// followingId = the boost owner). Clicks come from the stored
// linkClicks counter — clicks are only recorded while the boost is
// live, so the counter is already the window count. Only approved
// boosts have a window; pending and rejected boosts return null.
// Counts are single indexed lookups (post_views.post_id,
// reel_views.reel_id, follows.following_id) and run only for the
// requesting user's own boosts.
//
// Post views are unique first-views (post_views) PLUS counted repeat
// views on the live boost (post_boost_views, owner order 2026-11-26:
// every repeat view counts, at most one per viewer per boost per 10
// minutes, never the boost owner's own). The repeat table starts
// empty, so boosts that ran before the change keep their exact old
// numbers. Reels are untouched — repeat counting is posts-only.
async function getBoostResults(
  boost: {
    id: string;
    status: PostBoostStatus; contentType: string;
    postId: string | null; reelId: string | null;
    startsAt: Date | null; endsAt: Date | null;
    linkClicks: number;
  },
  userId: string,
): Promise<{ views: number | null; followers: number; clicks: number } | null> {
  // 'expired' is included: a boost ended by its click cap has stored
  // status 'expired' (endsAt = when the cap was hit) and its results
  // must stay visible. Pending/rejected boosts have no window
  // (startsAt null) and still return null.
  if ((boost.status !== PostBoostStatus.approved && boost.status !== PostBoostStatus.expired) || !boost.startsAt) return null;
  const window = { gte: boost.startsAt, lt: boost.endsAt ?? new Date() };
  const [views, followers] = await Promise.all([
    boost.contentType === 'reel'
      ? (boost.reelId
          ? prisma.reelView.count({ where: { reelId: boost.reelId, createdAt: window } })
          : Promise.resolve<number | null>(null))
      : (boost.postId
          ? postViewsWithRepeats(boost.postId, boost.id, window)
          : Promise.resolve<number | null>(null)),
    prisma.follow.count({ where: { followingId: userId, createdAt: window } }),
  ]);
  return { views, followers, clicks: boost.linkClicks };
}

// Post views for a boost window: unique first-views (post_views) plus
// counted repeat views on the live boost (post_boost_views). Both
// counts are windowed on their own timestamps (createdAt for first
// views, viewedAt for repeats).
async function postViewsWithRepeats(
  postId: string,
  boostId: string,
  window: { gte: Date; lt: Date },
): Promise<number> {
  const [unique, repeats] = await Promise.all([
    prisma.postView.count({ where: { postId, createdAt: window } }),
    prisma.postBoostView.count({ where: { boostId, viewedAt: window } }),
  ]);
  return unique + repeats;
}

// Record one click on a live boost's link button (POST
// /api/boosts/:id/click, any logged-in viewer). One counted click per
// viewer per boost per hour — the unique index on boost_link_clicks
// (boostId, viewerId, hourBucket) makes the guard race-safe: a repeat
// click inside the hour inserts nothing and the counter does not move.
// When the counter reaches the boost's clickCap (if set), the boost
// ends immediately: stored status becomes 'expired' and endsAt = now,
// so the feed stops serving it at once. Returns whether the click was
// counted, the new total, and whether the cap ended the boost.
export async function recordBoostLinkClick(
  boostId: string,
  viewerId: string,
): Promise<{ counted: boolean; clicks: number; ended: boolean }> {
  const boost = await prisma.postBoost.findUnique({
    where: { id: boostId },
    select: { id: true, status: true, startsAt: true, endsAt: true, linkClicks: true },
  });
  if (!boost) throw new ApiError(404, 'BOOST_NOT_FOUND', 'Boost not found.');

  const now = new Date();
  const live = boost.status === PostBoostStatus.approved
    && !!boost.startsAt && boost.startsAt <= now
    && (!boost.endsAt || boost.endsAt > now);
  if (!live) {
    throw new ApiError(409, 'BOOST_NOT_LIVE', 'This boost is no longer running.');
  }

  const hourBucket = Math.floor(now.getTime() / 3_600_000);

  return prisma.$transaction(async (tx) => {
    try {
      await tx.boostLinkClick.create({ data: { boostId, viewerId, hourBucket } });
    } catch (err: any) {
      if (err?.code === 'P2002') {
        // Same viewer clicked this boost within the hour — not counted.
        const current = await tx.postBoost.findUnique({ where: { id: boostId }, select: { linkClicks: true } });
        return { counted: false, clicks: current?.linkClicks ?? boost.linkClicks, ended: false };
      }
      throw err;
    }

    // Count only if the boost is still live at this instant (a boost
    // that ended between the check above and this write loses the
    // click instead of counting past its end).
    const inc = await tx.postBoost.updateMany({
      where: {
        id: boostId,
        status: PostBoostStatus.approved,
        startsAt: { lte: now },
        endsAt: { gt: now },
      },
      data: { linkClicks: { increment: 1 } },
    });
    if (inc.count !== 1) {
      return { counted: false, clicks: boost.linkClicks, ended: true };
    }

    const current = await tx.postBoost.findUnique({
      where: { id: boostId },
      select: { linkClicks: true, clickCap: true },
    });
    const clicks = current?.linkClicks ?? boost.linkClicks + 1;

    let ended = false;
    if (current?.clickCap !== null && current?.clickCap !== undefined && clicks >= current.clickCap) {
      const endResult = await tx.postBoost.updateMany({
        where: { id: boostId, status: PostBoostStatus.approved },
        data: { status: PostBoostStatus.expired, endsAt: now },
      });
      ended = endResult.count === 1;
    }
    return { counted: true, clicks, ended };
  });
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
  boostId: string;
  // Owner of the boost — set by getActiveBoostPostInfo only (the
  // repeat-view rule needs it to exclude the owner's own views).
  // Reel info does not carry it; reels are untouched by this change.
  userId?: string;
  purpose: string;
  linkUrl: string | null;
  buttonText: string | null;
}

// Live-boost details for a set of posts/reels, keyed by content id. The
// feeds and single-content reads use this to attach the boost button:
// Followers Gain boosts carry a Follow button, Clicks boosts with a
// link carry that link as a button (legacy Business Promotion boosts
// keep theirs), Views Gain boosts carry no button (see boostButtonFor).
// The boost id rides along so the button can record the click
// (POST /api/boosts/:id/click) before opening the link.
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
    select: { id: true, postId: true, userId: true, purpose: true, linkUrl: true, buttonText: true },
    orderBy: { endsAt: 'asc' },
  });
  for (const r of rows) {
    if (r.postId && !map.has(r.postId)) {
      map.set(r.postId, { boostId: r.id, userId: r.userId, purpose: r.purpose, linkUrl: r.linkUrl, buttonText: r.buttonText });
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
    select: { id: true, reelId: true, purpose: true, linkUrl: true, buttonText: true },
    orderBy: { endsAt: 'asc' },
  });
  for (const r of rows) {
    if (r.reelId && !map.has(r.reelId)) {
      map.set(r.reelId, { boostId: r.id, purpose: r.purpose, linkUrl: r.linkUrl, buttonText: r.buttonText });
    }
  }
  return map;
}

// The button a boosted item shows in the feed, derived from its boost:
// Follow for Followers Gain, the user's link (with its chosen text) for
// Clicks with a link — and for legacy Business Promotion rows, which
// keep the button they were created with — and nothing otherwise.
export function boostButtonFor(
  info?: ActiveBoostInfo | null,
): { type: 'follow' } | { type: 'link'; url: string; text: string; boostId: string } | null {
  if (!info) return null;
  if (info.purpose === 'followers_gain') return { type: 'follow' };
  if ((info.purpose === 'clicks' || info.purpose === 'business_promotion') && info.linkUrl) {
    return { type: 'link', url: info.linkUrl, text: info.buttonText || 'Learn More', boostId: info.boostId };
  }
  return null;
}

// Of `postIds`, the ones this viewer saw at least
// BOOST_REPEAT_AFTER_HOURS ago. The feeds use this to let a BOOSTED
// item re-appear through its boost slot once the earlier view is old;
// a fresh view (< 6h) still blocks the slot, and normal (non-boosted)
// content is never affected — its seen rule is unchanged.
// Reads lastViewedAt (refreshed on every view), NOT createdAt — the
// first-ever view timestamp never moves, so reading createdAt made
// every old view permanently stale and the house ad stuck at slot 0.
export async function getStaleViewedPostIds(viewerId: string, postIds: string[]): Promise<Set<string>> {
  if (!viewerId || postIds.length === 0) return new Set();
  const cutoff = new Date(Date.now() - BOOST_REPEAT_AFTER_HOURS * 60 * 60 * 1000);
  const rows = await prisma.postView.findMany({
    where: { viewerId, postId: { in: postIds }, lastViewedAt: { lt: cutoff } },
    select: { postId: true },
  }).catch(() => [] as Array<{ postId: string }>);
  return new Set(rows.map((r) => r.postId));
}

export async function getStaleViewedReelIds(viewerId: string, reelIds: string[]): Promise<Set<string>> {
  if (!viewerId || reelIds.length === 0) return new Set();
  const cutoff = new Date(Date.now() - BOOST_REPEAT_AFTER_HOURS * 60 * 60 * 1000);
  const rows = await prisma.reelView.findMany({
    where: { viewerId, reelId: { in: reelIds }, lastViewedAt: { lt: cutoff } },
    select: { reelId: true },
  }).catch(() => [] as Array<{ reelId: string }>);
  return new Set(rows.map((r) => r.reelId));
}

// ---- Boost audience targeting (owner, 2026-11-18) ----
// A boost should reach the people most likely to give it results: a
// Followers Gain boost goes first to people who follow a lot, a Views
// Gain boost goes first to people who mostly just watch. The feeds
// rank their eligible boost slots by this viewer's two affinities
// before the page rotation picks the slots. Targeting changes the
// ORDER only, never eligibility — every boost still rotates through
// later pages, so no boost is starved. Anonymous viewers and any
// counting failure fall back to neutral affinities (0.5 / 0.5), which
// keeps the plain soonest-expiring-first order.
export interface BoostAffinities {
  follow: number;
  view: number;
}

export async function getViewerBoostAffinities(
  viewerId: string | null | undefined,
  kind: 'post' | 'reel',
): Promise<BoostAffinities> {
  const neutral: BoostAffinities = { follow: 0.5, view: 0.5 };
  if (!viewerId) return neutral;
  try {
    const [follows, views] = await Promise.all([
      prisma.follow.count({ where: { followerId: viewerId } }),
      kind === 'post'
        ? prisma.postView.count({ where: { viewerId } })
        : prisma.reelView.count({ where: { viewerId } }),
    ]);
    const total = follows + views;
    if (total <= 0) return neutral;
    return { follow: follows / total, view: views / total };
  } catch {
    return neutral;
  }
}

// Stable re-order of eligible boost content ids for one viewer:
// Followers Gain boosts score the viewer's follow affinity, Views
// Gain boosts score the view affinity, Clicks sits in the middle
// (0.5) — like legacy Business Promotion did. Equal scores keep the
// incoming order (Array.sort is stable), which is soonest-expiring
// first.
export function orderBoostIdsForViewer(
  ids: string[],
  info: Map<string, ActiveBoostInfo>,
  affinities: BoostAffinities,
): string[] {
  const score = (id: string): number => {
    const purpose = info.get(id)?.purpose;
    if (purpose === 'followers_gain') return affinities.follow;
    if (purpose === 'views_gain') return affinities.view;
    return 0.5;
  };
  return [...ids].sort((a, b) => score(b) - score(a));
}
