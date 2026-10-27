import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';

// Monetization apply flow (owner order 2026-10-27):
// 25 referrals + BlueTick (isVerified) -> user applies -> admin approves
// -> monetization ON (monetizationForced). Admin approval is the ONLY way
// ON; the referral count alone never auto-enables earning (see
// viewsEarningService.isMonetized). A rejected user may re-apply once the
// missing requirement is fixed.
// The table is created at startup (ensureMonetizationRequestSchema, called
// from server.ts), mirroring the monetization_forced column precedent,
// because this repo has no Prisma migrations.

export const MONETIZATION_REFERRAL_THRESHOLD = 25;

let schemaReady = false;

export async function ensureMonetizationRequestSchema(): Promise<void> {
  if (schemaReady) return;
  await prisma.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS monetization_requests (id VARCHAR(191) NOT NULL PRIMARY KEY, user_id VARCHAR(191) NOT NULL, status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending', admin_note VARCHAR(1000) NULL, reviewed_by VARCHAR(191) NULL, reviewed_at DATETIME(3) NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), KEY monetization_requests_user_id_status_idx (user_id, status), KEY monetization_requests_status_created_at_idx (status, created_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  );
  schemaReady = true;
}

export type MonetizationEligibility = {
  referralCount: number;
  referralsNeeded: number;
  hasBlueTick: boolean;
  eligible: boolean;
  missing: string[];
};

export async function getMonetizationEligibility(userId: string): Promise<MonetizationEligibility> {
  const [user, referralCount] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { isVerified: true } }),
    prisma.referral.count({ where: { referrerId: userId } }),
  ]);
  const missing: string[] = [];
  if (referralCount < MONETIZATION_REFERRAL_THRESHOLD) missing.push('referrals');
  if (!user?.isVerified) missing.push('blueTick');
  return {
    referralCount,
    referralsNeeded: Math.max(0, MONETIZATION_REFERRAL_THRESHOLD - referralCount),
    hasBlueTick: user?.isVerified ?? false,
    eligible: missing.length === 0,
    missing,
  };
}

type RequestRow = {
  id: string;
  userId: string;
  status: string;
  adminNote: string | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function toDTO(r: RequestRow) {
  return {
    id: r.id,
    userId: r.userId,
    status: r.status,
    adminNote: r.adminNote,
    reviewedBy: r.reviewedBy,
    reviewedAt: r.reviewedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export async function applyForMonetization(userId: string) {
  await ensureMonetizationRequestSchema();
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { monetizationForced: true } });
  if (user?.monetizationForced) {
    throw new ApiError(409, 'ALREADY_MONETIZED', 'Monetization is already enabled for this account.');
  }
  const pending = await prisma.monetizationRequest.findFirst({ where: { userId, status: 'pending' } });
  if (pending) return { request: toDTO(pending), alreadyPending: true };
  const eligibility = await getMonetizationEligibility(userId);
  if (!eligibility.eligible) {
    throw new ApiError(400, 'MONETIZATION_REQUIREMENTS_NOT_MET', 'Complete 25 referrals and BlueTick before applying for monetization.');
  }
  const created = await prisma.monetizationRequest.create({ data: { userId } });
  return { request: toDTO(created), alreadyPending: false, eligibility };
}

export async function getMyMonetization(userId: string) {
  await ensureMonetizationRequestSchema();
  const [user, latest] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { monetizationForced: true } }),
    prisma.monetizationRequest.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } }),
  ]);
  const eligibility = await getMonetizationEligibility(userId);
  return {
    monetized: user?.monetizationForced ?? false,
    request: latest ? toDTO(latest) : null,
    eligibility,
  };
}

export async function listMonetizationRequests(status?: string) {
  await ensureMonetizationRequestSchema();
  const requests = await prisma.monetizationRequest.findMany({
    where:
      status === 'pending'
        ? { status: 'pending' }
        : status === 'approved'
          ? { status: 'approved' }
          : status === 'rejected'
            ? { status: 'rejected' }
            : {},
    orderBy: { createdAt: 'asc' },
    take: 200,
  });
  return { requests: requests.map(toDTO) };
}

export async function reviewMonetizationRequest(
  adminId: string,
  requestId: string,
  action: 'approve' | 'reject',
  adminNote?: string,
) {
  await ensureMonetizationRequestSchema();
  const request = await prisma.monetizationRequest.findUnique({
    where: { id: requestId },
    select: { id: true, userId: true, status: true },
  });
  if (!request) throw new ApiError(404, 'MONETIZATION_REQUEST_NOT_FOUND', 'Monetization request not found.');
  if (request.status !== 'pending') {
    throw new ApiError(409, 'MONETIZATION_REQUEST_ALREADY_REVIEWED', 'This request has already been reviewed.');
  }
  if (action === 'approve') {
    const eligibility = await getMonetizationEligibility(request.userId);
    if (!eligibility.eligible) {
      throw new ApiError(403, 'MONETIZATION_REQUIREMENTS_NOT_MET', 'This user no longer meets all monetization requirements.');
    }
  }
  const now = new Date();
  const nextStatus = action === 'approve' ? 'approved' : 'rejected';
  await prisma.$transaction(async (tx) => {
    const updated = await tx.monetizationRequest.updateMany({
      where: { id: request.id, status: 'pending' },
      data: { status: nextStatus, adminNote: adminNote || null, reviewedBy: adminId, reviewedAt: now },
    });
    if (updated.count === 0) {
      throw new ApiError(409, 'MONETIZATION_REQUEST_ALREADY_REVIEWED', 'This request has already been reviewed.');
    }
    if (action === 'approve') {
      await tx.user.update({ where: { id: request.userId }, data: { monetizationForced: true } });
    }
  });
  const finalRequest = await prisma.monetizationRequest.findUnique({ where: { id: request.id } });
  if (!finalRequest) throw new ApiError(404, 'MONETIZATION_REQUEST_NOT_FOUND', 'Monetization request not found.');
  return { request: toDTO(finalRequest) };
}
