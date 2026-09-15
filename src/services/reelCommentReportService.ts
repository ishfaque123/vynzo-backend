import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';

export async function reportReelComment(userId: string, commentId: string, reason: string = 'other', details?: string) {
  const comment = await prisma.reelComment.findUnique({ where: { id: commentId }, select: { id: true } });
  if (!comment) throw new ApiError(404, 'COMMENT_NOT_FOUND', 'Comment not found.');
  const existing = await prisma.reelCommentReport.findUnique({ where: { commentId_reporterId: { commentId, reporterId: userId } } });
  if (existing) throw new ApiError(400, 'ALREADY_REPORTED', 'You have already reported this comment.');
  await prisma.reelCommentReport.create({ data: { commentId, reporterId: userId, reason: reason as any, details } });
  return { reported: true };
}
