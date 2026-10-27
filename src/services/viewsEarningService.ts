import { prisma } from '../config/prisma';

// Views-only earning (owner order 2026-10-27):
// - A user is monetized once they have 25 referrals (or an admin forces it
//   via monetizationForced). Referrals themselves pay nothing.
// - Monetized users earn $0.06 per 1,000 qualifying views on their posts
//   and reels. A qualifying view is one unique viewer on the owner's
//   content, excluding the owner's own views. Post views are unique per
//   viewer by schema; reel views are deduplicated the same way (unique
//   key on (reel_id, viewer_id) enforced at runtime).
// - No schema change: views already paid are derived from existing
//   type='views' earning records (exactly one record per 1,000 views),
//   so accrual never double-pays. Existing referral earnings are untouched.

export const MONETIZATION_REFERRAL_THRESHOLD = 25;
export const VIEWS_EARNING_USD_PER_1000 = 0.06;
export const VIEWS_PER_PAYOUT = 1000;
// Bound one call so a huge backlog cannot create an unbounded transaction;
// leftovers accrue on the next view.
const MAX_PAYOUTS_PER_CALL = 100;

export async function isMonetized(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { monetizationForced: true },
  });
  if (!user) return false;
  if (user.monetizationForced) return true;
  const referralCount = await prisma.referral.count({ where: { referrerId: userId } });
  return referralCount >= MONETIZATION_REFERRAL_THRESHOLD;
}

async function countQualifyingViews(userId: string): Promise<number> {
  const [postViews, reelViews] = await Promise.all([
    prisma.postView.count({
      where: { viewerId: { not: userId }, post: { userId } },
    }),
    prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT COUNT(DISTINCT rv.reel_id, rv.viewer_id) AS n FROM reel_views rv INNER JOIN reels r ON r.id = rv.reel_id WHERE r.user_id = ? AND rv.viewer_id != ?`,
      userId,
      userId,
    ),
  ]);
  return postViews + Number(reelViews[0]?.n ?? 0);
}

export async function accrueViewsEarnings(ownerId: string): Promise<{ credited: number; totalViews: number }> {
  if (!(await isMonetized(ownerId))) return { credited: 0, totalViews: 0 };
  const totalViews = await countQualifyingViews(ownerId);
  const paidRecords = await prisma.earning.count({ where: { userId: ownerId, type: 'views' } });
  const paidViews = paidRecords * VIEWS_PER_PAYOUT;
  const unpaidThousands = Math.floor((totalViews - paidViews) / VIEWS_PER_PAYOUT);
  const payouts = Math.min(Math.max(unpaidThousands, 0), MAX_PAYOUTS_PER_CALL);
  if (payouts <= 0) return { credited: 0, totalViews };
  const amount = payouts * VIEWS_EARNING_USD_PER_1000;
  await prisma.$transaction([
    ...Array.from({ length: payouts }, (_, i) =>
      prisma.earning.create({
        data: {
          userId: ownerId,
          amount: VIEWS_EARNING_USD_PER_1000,
          type: 'views',
          referenceId: `views:${paidViews + (i + 1) * VIEWS_PER_PAYOUT}`,
        },
      }),
    ),
    prisma.user.update({
      where: { id: ownerId },
      data: { walletBalance: { increment: amount } },
    }),
  ]);
  return { credited: amount, totalViews };
}
