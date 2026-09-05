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

  if (post.commentAudience === 'only_me' && post.userId !== userId) {
    throw new ApiError(403, 'COMMENTS_RESTRICTED', 'Only the author can comment on this post.');
  }
  if (post.commentAudience === 'followers' && post.userId !== userId) {
    const isFollower = await prisma.follow.findUnique({
      where: { followerId_followingId: { followerId: userId, followingId: post.userId } },
    });
    if (!isFollower) {
      throw new ApiError(403, 'COMMENTS_RESTRICTED', 'Only followers can comment on this post.');
    }
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
  const user = await prisma.user.update({ where: { id: userId }, data: { commentsDisabled: disabled } });
  return { commentsDisabled: user.commentsDisabled };
}

export async function deleteComment(userId: string, commentId: string) {
  const comment = await prisma.comment.findUnique({
    where: { id: commentId },
    include: { post: true },
  });

  if (!comment) {
    throw new ApiError(404, 'COMMENT_NOT_FOUND', 'Comment not found.');
  }

  if (comment.userId !== userId && comment.post.userId !== userId) {
    throw new ApiError(403, 'COMMENT_DELETE_FORBIDDEN', 'You cannot delete this comment.');
  }

  await prisma.comment.delete({
    where: { id: commentId },
  });

  return { success: true };
}
