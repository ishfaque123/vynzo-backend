import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';

const authorSelect = { id: true, username: true, displayName: true, profilePictureUrl: true };

export async function editReelComment(userId: string, commentId: string, content: string) {
  const trimmed = content.trim();
  if (!trimmed) throw new ApiError(400, 'EMPTY_COMMENT', 'Comment cannot be empty.');
  if (trimmed.length > 500) throw new ApiError(400, 'COMMENT_TOO_LONG', 'Comment is too long.');

  const comment = await prisma.reelComment.findUnique({ where: { id: commentId } });
  if (!comment) throw new ApiError(404, 'COMMENT_NOT_FOUND', 'Comment not found.');
  if (comment.userId !== userId) throw new ApiError(403, 'FORBIDDEN', 'Not your comment.');

  const updated = await prisma.reelComment.update({
    where: { id: commentId },
    data: { content: trimmed },
    include: {
      user: { select: authorSelect },
      reactions: { select: { type: true, userId: true } },
    },
  });

  return {
    id: updated.id,
    reelId: updated.reelId,
    content: updated.content,
    createdAt: updated.createdAt,
    author: updated.user,
    reactionCount: updated.reactions.length,
    myReaction: updated.reactions.find((r) => r.userId === userId)?.type ?? null,
    replies: [],
  };
}
