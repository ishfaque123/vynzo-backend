import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';

function toCommentDTO(comment: any) {
  return {
    id: comment.id,
    content: comment.content,
    createdAt: comment.createdAt,
    author: {
      id: comment.user.id,
      username: comment.user.username,
      displayName: comment.user.displayName,
      profilePictureUrl: comment.user.profilePictureUrl,
    },
  };
}

export async function addComment(userId: string, postId: string, content: string) {
  const post = await prisma.post.findUnique({ where: { id: postId }, include: { user: true } });
  if (!post) throw new ApiError(404, 'POST_NOT_FOUND', 'Post not found.');
  if (post.user.commentsDisabled) {
    throw new ApiError(403, 'COMMENTS_DISABLED', 'Comments are disabled for this post.');
  }

  const comment = await prisma.comment.create({
    data: { userId, postId, content },
    include: { user: true },
  });
  return toCommentDTO(comment);
}

export async function getComments(postId: string) {
  const comments = await prisma.comment.findMany({
    where: { postId },
    orderBy: { createdAt: 'asc' },
    include: { user: true },
  });
  return comments.map(toCommentDTO);
}

export async function toggleCommentsSetting(userId: string, disabled: boolean) {
  const user = await prisma.user.update({
    where: { id: userId },
    data: { commentsDisabled: disabled },
  });
  return { commentsDisabled: user.commentsDisabled };
}
