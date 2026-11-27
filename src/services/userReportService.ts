import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';
import { assertMonthlyReportAllowance } from './moderationService';

type ReportReasonType = 'spam' | 'harassment' | 'hate_speech' | 'violence' | 'nudity' | 'misinformation' | 'other';

export async function reportUser(reporterId: string, reportedId: string, reason: ReportReasonType, details?: string) {
  if (reporterId === reportedId) {
    throw new ApiError(400, 'INVALID_TARGET', 'You cannot report yourself.');
  }
  const target = await prisma.user.findUnique({ where: { id: reportedId } });
  if (!target) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found.');

  // One report per user per calendar month across all report types
  // (user-ordered 2026-11-26). Only a NEW row consumes quota: an existing
  // row just updates its reason/details without the monthly check.
  const existing = await prisma.userReport.findUnique({ where: { reporterId_reportedId: { reporterId, reportedId } } });
  if (!existing) await assertMonthlyReportAllowance(reporterId);

  await prisma.userReport.upsert({
    where: { reporterId_reportedId: { reporterId, reportedId } },
    update: { reason, details },
    create: { reporterId, reportedId, reason, details },
  });

  return { reported: true };
}
