import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';
import { env } from '../config/env';
import { deleteFromR2 } from '../config/r2';
import { getFriendStatus } from './followService';
import { isEitherBlocked } from './blockService';

const authorSelect = { id: true, username: true, displayName: true, profilePictureUrl: true };

export async function addReelComment(userId: string, reelId: string, content: string, parentCommentId?: string) {
  const reel = await prisma.reel.findUnique({ where: { id: reelId } });
  if (!reel) throw new ApiError(404, 'REEL_NOT_FOUND', 'Reel not found.');
  if (await isEitherBlocked(userId, reel.userId)) throw new ApiError(403, 'BLOCKED', 'Cannot comment on this reel.');

  const trimmed = content.trim();
  if (!trimmed) throw new ApiError(400, 'EMPTY_COMMENT', 'Comment cannot be empty.');

  if (parentCommentId) {
    const parent = await prisma.reelComment.findUnique({ where: { id: parentCommentId }, select: { id: true, reelId: true } });
    if (!parent || parent.reelId !== reelId) {
      throw new ApiError(400, 'INVALID_PARENT', 'Reply target is invalid.');
    }
  }

  return prisma.reelComment.create({
    data: { reelId, userId, parentCommentId, content: trimmed },
    include: { user: { select: authorSelect } },
  });
}

export async function getReelComments(reelId: string, currentUserId: string) {
  const rows = await prisma.reelComment.findMany({
    where: { reelId },
    orderBy: { createdAt: 'asc' },
    include: {
      user: { select: authorSelect },
      reactions: {
        select: { type: true, userId: true },
      },
    },
  });
  const mapped = rows.map((row: any) => ({ ...row, author: row.user, reactionCount: row.reactions.length, myReaction: row.reactions.find((r: any) => r.userId === currentUserId)?.type ?? null }));
  const byId = new Map<string, any>(mapped.map((row: any) => [row.id, { ...row, replies: [] }]));
  const roots: any[] = [];
  for (const row of mapped) {
    const node = byId.get(row.id)!;
    if (row.parentCommentId && byId.has(row.parentCommentId)) byId.get(row.parentCommentId)!.replies.push(node);
    else roots.push(node);
  }
  return roots;
}

export async function reportReelComment(userId: string, commentId: string, reason: string = 'other', details?: string) {
  const comment = await prisma.reelComment.findUnique({ where: { id: commentId }, select: { id: true } });
  if (!comment) throw new ApiError(404, 'COMMENT_NOT_FOUND', 'Comment not found.');
  const existing = await prisma.commentReport.findUnique({ where: { commentId_reporterId: { commentId, reporterId: userId } } });
  if (existing) throw new ApiError(400, 'ALREADY_REPORTED', 'You have already reported this comment.');
  await prisma.commentReport.create({ data: { commentId, reporterId: userId, reason: reason as any, details } });
  return { reported: true };
}
