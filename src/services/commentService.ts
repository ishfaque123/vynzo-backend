import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';
import { getFriendStatus } from './followService';
import { createNotification } from './notificationService';

function toAuthorDTO(user: any) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    profilePictureUrl: user.profilePictureUrl,
  };
}

async function toCommentDTO(comment: any, currentUserId?: string): Promise<any> {
  const myReaction = currentUserId ? comment.reactions?.find((r: any) => r.userId === currentUserId) : null;
  const friendStatus = await getFriendStatus(currentUserId, comment.userId);
  return {
    id: comment.id,
    content: comment.content,
    createdAt: comment.createdAt,
    author: toAuthorDTO(comment.user),
    friendStatus,
    reactionCount: comment.reactions?.length ?? 0,
    myReaction: myReaction ? myReaction.type : null,
    taggedUsers: comment.tags?.map((t: any) => toAuthorDTO(t.user)) ?? [],
    replies: comment.replies ? await Promise.all(comment.replies.map((r: any) => toCommentDTO(r, currentUserId))) : [],
  };
}

const includeShape = {
  user: true,
  reactions: true,
  tags: { include: { user: true } },
  replies: {
    include: { user: true, reactions: true, tags: { include: { user: true } } },
    orderBy: { createdAt: 'asc' as const },
  },
};

export async function addComment(
  userId: string,
  postId: string,
  content: string,
  parentCommentId?: string,
  taggedUserIds: string[] = []
) {
  const post = await prisma.post.findUnique({ where: { id: postId }, include: { user: true } });
  if (!post) throw new ApiError(404, 'POST_NOT_FOUND', 'Post not found.');
  if (post.user.commentsDisabled) throw new ApiError(403, 'COMMENTS_DISABLED', 'Comments are disabled for this post.');

  if (post.commentAudience === 'only_me' && post.userId !== userId) {
    throw new ApiError(403, 'COMMENTS_RESTRICTED', 'Only the author can comment on this post.');
  }
  if (post.commentAudience === 'followers' && post.userId !== userId) {
    const isFollower = await prisma.follow.findUnique({ where: { followerId_followingId: { followerId: userId, followingId: post.userId } } });
    if (!isFollower) throw new ApiError(403, 'COMMENTS_RESTRICTED', 'Only followers can comment on this post.');
  }

  const comment = await prisma.comment.create({
    data: {
      userId,
      postId,
      content,
      parentCommentId,
      tags: { create: taggedUserIds.slice(0, 2).map((id) => ({ userId: id })) },
    },
    include: includeShape,
  });

  if (parentCommentId) {
    const parentComment = await prisma.comment.findUnique({ where: { id: parentCommentId } });
    if (parentComment) {
      await createNotification({ userId: parentComment.userId, actorId: userId, type: 'comment_reply', postId, commentId: parentCommentId });
    }
  } else {
    await createNotification({ userId: post.userId, actorId: userId, type: 'post_comment', postId });
  }

  return toCommentDTO(comment, userId);
}

export async function getComments(postId: string, currentUserId?: string) {
  const allComments = await prisma.comment.findMany({
    where: { postId },
    orderBy: { createdAt: 'asc' },
    include: {
      user: true,
      reactions: true,
      tags: { include: { user: true } },
    },
  });

  const byId = new Map<string, any>();
  for (const c of allComments) byId.set(c.id, { ...c, children: [] as any[] });

  const roots: any[] = [];
  for (const c of byId.values()) {
    if (c.parentCommentId && byId.has(c.parentCommentId)) {
      byId.get(c.parentCommentId).children.push(c);
    } else {
      roots.push(c);
    }
  }

  async function buildDTO(c: any): Promise<any> {
    const myReaction = currentUserId ? c.reactions?.find((r: any) => r.userId === currentUserId) : null;
    const friendStatus = await getFriendStatus(currentUserId, c.userId);
    return {
      id: c.id,
      content: c.content,
      createdAt: c.createdAt,
      author: toAuthorDTO(c.user),
      friendStatus,
      reactionCount: c.reactions?.length ?? 0,
      myReaction: myReaction ? myReaction.type : null,
      taggedUsers: c.tags?.map((t: any) => toAuthorDTO(t.user)) ?? [],
      replies: await Promise.all(c.children.map((r: any) => buildDTO(r))),
    };
  }

  return Promise.all(roots.map((r) => buildDTO(r)));
}

export async function setCommentReaction(userId: string, commentId: string, type: string) {
  const comment = await prisma.comment.findUnique({ where: { id: commentId } });
  if (!comment) throw new ApiError(404, 'COMMENT_NOT_FOUND', 'Comment not found.');

  const existing = await prisma.commentReaction.findUnique({ where: { userId_commentId: { userId, commentId } } });
  if (existing && existing.type === type) {
    await prisma.commentReaction.delete({ where: { id: existing.id } });
    const count = await prisma.commentReaction.count({ where: { commentId } });
    return { reaction: null, reactionCount: count };
  }
  await prisma.commentReaction.upsert({
    where: { userId_commentId: { userId, commentId } },
    update: { type: type as any },
    create: { userId, commentId, type: type as any },
  });

  if (!existing) {
    await createNotification({ userId: comment.userId, actorId: userId, type: 'comment_like', postId: comment.postId, commentId });
  }

  const count = await prisma.commentReaction.count({ where: { commentId } });
  return { reaction: type, reactionCount: count };
}

export async function editComment(userId: string, commentId: string, content: string) {
  const comment = await prisma.comment.findUnique({ where: { id: commentId } });
  if (!comment) throw new ApiError(404, 'COMMENT_NOT_FOUND', 'Comment not found.');
  if (comment.userId !== userId) throw new ApiError(403, 'FORBIDDEN', 'Not your comment.');
  const updated = await prisma.comment.update({ where: { id: commentId }, data: { content }, include: includeShape });
  return toCommentDTO(updated, userId);
}

export async function deleteComment(userId: string, commentId: string) {
  const comment = await prisma.comment.findUnique({ where: { id: commentId }, include: { post: true } });
  if (!comment) throw new ApiError(404, 'COMMENT_NOT_FOUND', 'Comment not found.');
  if (comment.userId !== userId && comment.post.userId !== userId) {
    throw new ApiError(403, 'FORBIDDEN', 'Not authorized to delete this comment.');
  }
  await prisma.comment.delete({ where: { id: commentId } });
}

export async function toggleCommentsSetting(userId: string, disabled: boolean) {
  const user = await prisma.user.update({ where: { id: userId }, data: { commentsDisabled: disabled } });
  return { commentsDisabled: user.commentsDisabled };
}
