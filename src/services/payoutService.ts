import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';

// Allowed payout methods per country
export const PAYOUT_METHODS: Record<string, { code: string; label: string; fields: { accountNumber: string; extra?: string } }[]> = {
  PK: [
    { code: 'easypaisa', label: 'EasyPaisa', fields: { accountNumber: 'Mobile number' } },
    { code: 'jazzcash', label: 'JazzCash', fields: { accountNumber: 'Mobile number' } },
    { code: 'bank', label: 'Bank Transfer', fields: { accountNumber: 'IBAN', extra: 'Bank name' } },
  ],
  IN: [
    { code: 'upi', label: 'UPI', fields: { accountNumber: 'UPI ID' } },
    { code: 'paytm', label: 'Paytm', fields: { accountNumber: 'Mobile number' } },
    { code: 'bank', label: 'Bank Transfer', fields: { accountNumber: 'Account number', extra: 'IFSC code' } },
  ],
  US: [
    { code: 'bank', label: 'Bank Transfer', fields: { accountNumber: 'Account number', extra: 'Routing number' } },
    { code: 'paypal', label: 'PayPal', fields: { accountNumber: 'PayPal email' } },
  ],
};

const COUNTRY_NAMES: Record<string, string> = {
  PK: 'Pakistan', IN: 'India', US: 'United States',
};

export function normalizeCountryCode(raw?: string | null): string | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (v === 'pk' || v === 'pakistan') return 'PK';
  if (v === 'in' || v === 'india') return 'IN';
  if (v === 'us' || v === 'usa' || v === 'united states' || v === 'united states of america' || v === 'america') return 'US';
  return null;
}

function toDTO(m: any) {
  const countryMethods = PAYOUT_METHODS[m.country] || [];
  const methodLabel = countryMethods.find((x) => x.code === m.methodType)?.label || m.methodType;
  return {
    id: m.id,
    country: m.country,
    methodType: m.methodType,
    methodLabel,
    accountName: m.accountName,
    accountNumber: m.accountNumber,
    extra: m.extra,
    isDefault: m.isDefault,
    createdAt: m.createdAt,
  };
}

export async function getPayoutMethods(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { country: true } });
  const countryCode = normalizeCountryCode(user?.country);
  const methods = await prisma.payoutMethod.findMany({
    where: { userId },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
  });
  return {
    methods: methods.map(toDTO),
    country: countryCode,
    countryName: countryCode ? COUNTRY_NAMES[countryCode] : null,
    allowed: countryCode ? { [countryCode]: PAYOUT_METHODS[countryCode] } : {},
  };
}

export async function addPayoutMethod(userId: string, data: {
  methodType: string; accountName: string; accountNumber: string; extra?: string;
}) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { country: true } });
  const country = normalizeCountryCode(user?.country);
  if (!country) throw new ApiError(400, 'COUNTRY_REQUIRED', 'Please set your country in your profile first.');
  const allowed = PAYOUT_METHODS[country];
  if (!allowed.some((m) => m.code === data.methodType)) {
    throw new ApiError(400, 'INVALID_METHOD', 'Unsupported payout method for your country.');
  }
  if (!data.accountName?.trim()) throw new ApiError(400, 'NAME_REQUIRED', 'Account holder name is required.');
  if (!data.accountNumber?.trim()) throw new ApiError(400, 'ACCOUNT_REQUIRED', 'Account number is required.');

  const existing = await prisma.payoutMethod.count({ where: { userId } });
  const method = await prisma.payoutMethod.create({
    data: {
      userId,
      country,
      methodType: data.methodType,
      accountName: data.accountName.trim(),
      accountNumber: data.accountNumber.trim(),
      extra: data.extra?.trim() || null,
      isDefault: existing === 0,
    },
  });
  return toDTO(method);
}

export async function deletePayoutMethod(userId: string, id: string) {
  const method = await prisma.payoutMethod.findFirst({ where: { id, userId } });
  if (!method) throw new ApiError(404, 'NOT_FOUND', 'Payout method not found.');
  await prisma.payoutMethod.delete({ where: { id } });
  // If deleted was default, make the newest one default
  if (method.isDefault) {
    const next = await prisma.payoutMethod.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } });
    if (next) await prisma.payoutMethod.update({ where: { id: next.id }, data: { isDefault: true } });
  }
  return { deleted: true };
}

export async function setDefaultPayoutMethod(userId: string, id: string) {
  const method = await prisma.payoutMethod.findFirst({ where: { id, userId } });
  if (!method) throw new ApiError(404, 'NOT_FOUND', 'Payout method not found.');
  await prisma.$transaction([
    prisma.payoutMethod.updateMany({ where: { userId }, data: { isDefault: false } }),
    prisma.payoutMethod.update({ where: { id }, data: { isDefault: true } }),
  ]);
  return { updated: true };
}

export async function getEarnings(userId: string, limit = 20) {
  const earnings = await prisma.earning.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(50, Math.max(1, limit)),
  });
  const total = await prisma.earning.aggregate({ where: { userId }, _sum: { amount: true } });
  const paid = await prisma.payout.aggregate({ where: { userId, status: 'sent' }, _sum: { amount: true } });
  return {
    earnings: earnings.map((e) => ({
      id: e.id,
      amount: e.amount,
      type: e.type,
      createdAt: e.createdAt,
    })),
    total: total._sum.amount ?? 0,
    totalPaid: paid._sum.amount ?? 0,
  };
}

// Users this user invited, most active first. "Active" = opened the app in
// the last 24 hours (users.last_active_at).
export async function getReferralsList(userId: string) {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await prisma.referral.findMany({
    where: { referrerId: userId },
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: {
      referredUser: {
        select: { username: true, displayName: true, profilePictureUrl: true, lastActiveAt: true },
      },
    },
  });
  const referrals = rows.map((r) => ({
    username: r.referredUser.username,
    displayName: r.referredUser.displayName,
    avatar: r.referredUser.profilePictureUrl,
    joinedAt: r.createdAt,
    active: !!r.referredUser.lastActiveAt && r.referredUser.lastActiveAt >= dayAgo,
  }));
  // Active first; the query order (newest first) is kept inside each group.
  referrals.sort((a, b) => Number(b.active) - Number(a.active));
  return {
    invited: referrals.length,
    activeDaily: referrals.filter((r) => r.active).length,
    referrals,
  };
}

// Earnings grouped per post/reel (earning rows that carry a referenceId).
export async function getEarningsByContent(userId: string) {
  const rows = await prisma.earning.findMany({
    where: { userId, referenceId: { not: null } },
    select: { referenceId: true, amount: true },
  });
  const totals = new Map<string, number>();
  for (const r of rows) {
    if (r.referenceId) totals.set(r.referenceId, (totals.get(r.referenceId) ?? 0) + r.amount);
  }
  const ids = [...totals.keys()];
  if (!ids.length) return { items: [] as ContentEarning[] };

  const [posts, reels, reelViews] = await Promise.all([
    prisma.post.findMany({
      where: { id: { in: ids }, userId },
      select: { id: true, content: true, imageUrl: true, _count: { select: { views: true } } },
    }),
    prisma.reel.findMany({
      where: { id: { in: ids }, userId },
      select: { id: true, caption: true, thumbnailUrl: true },
    }),
    prisma.reelView.groupBy({ by: ['reelId'], where: { reelId: { in: ids } }, _count: { _all: true } }),
  ]);
  const reelViewCounts = new Map(reelViews.map((v) => [v.reelId, v._count._all]));

  type ContentEarning = {
    id: string; kind: 'post' | 'reel'; title: string;
    thumbnail: string | null; views: number | null; amount: number;
  };
  const items: ContentEarning[] = [];
  for (const p of posts) {
    items.push({
      id: p.id, kind: 'post',
      title: (p.content || '').split('\n')[0].slice(0, 80) || 'Post',
      thumbnail: p.imageUrl, views: p._count.views, amount: totals.get(p.id) ?? 0,
    });
  }
  for (const r of reels) {
    items.push({
      id: r.id, kind: 'reel',
      title: (r.caption || '').split('\n')[0].slice(0, 80) || 'Reel',
      thumbnail: r.thumbnailUrl, views: reelViewCounts.get(r.id) ?? 0, amount: totals.get(r.id) ?? 0,
    });
  }
  items.sort((a, b) => b.amount - a.amount);
  return { items: items.slice(0, 20) };
}

export async function getPayoutHistory(userId: string) {
  const rows = await prisma.payout.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  return {
    payouts: rows.map((p) => ({
      id: p.id,
      amount: p.amount,
      status: p.status,
      methodLabel: p.methodLabel,
      createdAt: p.createdAt,
    })),
  };
}
