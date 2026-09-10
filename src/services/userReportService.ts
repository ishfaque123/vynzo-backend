import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';

type ReportReasonType = 'spam' | 'harassment' | 'hate_speech' | 'violence' | 'nudity' | 'misinformation' | 'other';

export async function reportUser(reporterId: string, reportedId: string, reason: ReportReasonType, details?: string) {
  if (reporterId === reportedId) {
    throw new ApiError(400, 'INVALID_TARGET', 'You cannot report yourself.');
  }
  const target = await prisma.user.findUnique({ where: { id: reportedId } });
  if (!target) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found.');

  await prisma.userReport.upsert({
    where: { reporterId_reportedId: { reporterId, reportedId } },
    update: { reason, details },
    create: { reporterId, reportedId, reason, details },
  });

  return { reported: true };
}
