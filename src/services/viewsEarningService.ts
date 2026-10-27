import { prisma } from '../config/prisma';

// Views-only earning (owner order 2026-10-27, apply flow 2026-10-27):
// - A user is monetized ONLY by admin approval (monetizationForced).
//   25 referrals + BlueTick are the APPLY eligibility, not auto-ON
//   (see monetizationService). Referrals themselves pay nothing.
// - Monetized users earn $0.06 per 1,000 qualifying views on their posts
//   and reels. A qualifying view is one unique viewer on the owner's
//   content, excluding the owner's own views. Post views are unique per
//   viewer by schema; reel views are deduplicated the same way (unique
//   key on (reel_id, viewer_id) enforced at runtime).
// - No schema change: views already paid are derived from existing
//   type='views' earning records (exactly one record per 1,000 views),
//   so accrual never double-pays. Existing referral earnings are untouched.
// - Concurrency: accrual locks the owner's user row inside a single
//   transaction and re-reads the paid count before writing. Without the
//   lock, two simultaneous views could both see the same unpaid balance
//   and pay it twice.

export const VIEWS_EARNING_USD_PER_1000 = 0.06;
export const VIEWS_PER_PAYOUT = 1000;
// Bound one call so a huge backlog cannot create an unbounded transaction;
// leftovers accrue on the next view.
const MAX_PAYOUTS_PER_CALL = 100;

export async function isMonetized(userId: string): Promise<boolean> {
  // Approval-only: monetization is ON only when an admin approved the
  // user's application (monetizationForced). Referral count and BlueTick
  // gate the application, not the earning itself.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { monetizationForced: true },
  });
  return user?.monetizationForced ?? false;
}

export async function accrueViewsEarnings(ownerId: string): Promise<{ credited: number; totalViews: number }> {
  if (!(await isMonetized(ownerId))) return { credited: 0, totalViews: 0 };
  return prisma.$transaction(async (tx) => {
    // Row lock: serializes concurrent accruals for the same owner.
    await tx.$queryRawUnsafe(`SELECT id FROM users WHERE id = ? FOR UPDATE`, ownerId);
    const postRows = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT COUNT(*) AS n FROM post_views pv INNER JOIN posts p ON p.id = pv.post_id WHERE p.user_id = ? AND pv.viewer_id != ?`,
      ownerId,
      ownerId,
    );
    const reelRows = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT COUNT(DISTINCT rv.reel_id, rv.viewer_id) AS n FROM reel_views rv INNER JOIN reels r ON r.id = rv.reel_id WHERE r.user_id = ? AND rv.viewer_id != ?`,
      ownerId,
      ownerId,
    );
    const totalViews = Number(postRows[0]?.n ?? 0) + Number(reelRows[0]?.n ?? 0);
    const paidRows = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT COUNT(*) AS n FROM earnings WHERE user_id = ? AND type = 'views'`,
      ownerId,
    );
    const paidViews = Number(paidRows[0]?.n ?? 0) * VIEWS_PER_PAYOUT;
    const unpaidThousands = Math.floor((totalViews - paidViews) / VIEWS_PER_PAYOUT);
    const payouts = Math.min(Math.max(unpaidThousands, 0), MAX_PAYOUTS_PER_CALL);
    if (payouts <= 0) return { credited: 0, totalViews };
    const amount = payouts * VIEWS_EARNING_USD_PER_1000;
    for (let i = 0; i < payouts; i++) {
      await tx.$executeRawUnsafe(
        `INSERT INTO earnings (id, user_id, amount, type, reference_id) VALUES (UUID(), ?, ?, 'views', ?)`,
        ownerId,
        VIEWS_EARNING_USD_PER_1000,
        `views:${paidViews + (i + 1) * VIEWS_PER_PAYOUT}`,
      );
    }
    await tx.$executeRawUnsafe(
      `UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?`,
      amount,
      ownerId,
    );
    return { credited: amount, totalViews };
  });
}
