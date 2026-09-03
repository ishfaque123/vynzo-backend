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
  const post = await prisma.post.findUnique({ where: { id: postId } });
  if (!post) throw new ApiError(404, 'POST_NOT_FOUND', 'Post not found.');

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
