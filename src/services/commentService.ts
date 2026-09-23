import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';
import { getFriendStatus } from './followService';
import { isEitherBlocked } from './blockService';
import { createNotification } from './notificationService';

function toAuthorDTO(user: any) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    profilePictureUrl: user.profilePictureUrl,
    isVerified: user.isVerified ?? false,
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

  const parentAuthorId = parentCommentId
    ? (await prisma.comment.findUnique({ where: { id: parentCommentId }, select: { userId: true } }))?.userId
    : undefined;
  for (const taggedId of taggedUserIds.slice(0, 2)) {
    if (taggedId === userId || taggedId === post.userId || taggedId === parentAuthorId) continue;
    if (await isEitherBlocked(userId, taggedId)) continue;
    await createNotification({ userId: taggedId, actorId: userId, type: 'comment_mention', postId, commentId: comment.id });
  }

  return toCommentDTO(comment, userId);
}

const COMMENT_PAGE_SIZE = 20;

function encodeCommentCursor(createdAt: Date, id: string) {
  return Buffer.from(JSON.stringify({ createdAt: createdAt.toISOString(), id }), 'utf8').toString('base64url');
}

function decodeCommentCursor(cursor?: string) {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed?.createdAt !== 'string' || typeof parsed?.id !== 'string') return null;
    const createdAt = new Date(parsed.createdAt);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id: parsed.id };
  } catch {
    return null;
  }
}

export async function getComments(postId: string, currentUserId?: string, cursor?: string, limit = COMMENT_PAGE_SIZE) {
  // Bug fix: comments on a post used to be readable by anyone (even logged
  // out), regardless of whether they were allowed to see the post itself.
  // Same two checks as getPostById in postService.ts, for consistency:
  // account-level privacy first, then post-level visibility.
  const post = await prisma.post.findUnique({ where: { id: postId }, include: { user: true } });
  if (!post) throw new ApiError(404, 'POST_NOT_FOUND', 'Post not found.');

  if (post.user.isPrivate && post.userId !== currentUserId) {
    const friendStatus = await getFriendStatus(currentUserId, post.userId);
    if (friendStatus !== 'following' && friendStatus !== 'friends') {
      throw new ApiError(403, 'PRIVATE_ACCOUNT', 'This account is private.');
    }
  }
  if (post.visibility === 'private' && post.userId !== currentUserId) {
    throw new ApiError(404, 'POST_NOT_FOUND', 'Post not found.');
  }

  const safeLimit = Math.min(Math.max(limit, 1), COMMENT_PAGE_SIZE);
  const decodedCursor = decodeCommentCursor(cursor);
  if (cursor && !decodedCursor) throw new ApiError(400, 'INVALID_CURSOR', 'Invalid comment pagination cursor.');

  const rootWhere: any = { postId, parentCommentId: null };
  if (decodedCursor) {
    rootWhere.OR = [
      { createdAt: { lt: decodedCursor.createdAt } },
      { createdAt: decodedCursor.createdAt, id: { lt: decodedCursor.id } },
    ];
  }

  const roots = await prisma.comment.findMany({
    where: rootWhere,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: safeLimit + 1,
    include: { user: true, reactions: true, tags: { include: { user: true } } },
  });

  const hasMore = roots.length > safeLimit;
  const pageRoots = hasMore ? roots.slice(0, safeLimit) : roots;
  const rootIds = pageRoots.map((r) => r.id);

  // Fetch this page's replies level by level instead of the whole post's
  // comment tree — threads rarely go more than a few levels deep, so this
  // is a handful of small queries instead of one giant one.
  const allReplies: any[] = [];
  if (rootIds.length) {
    let frontier = rootIds;
    while (frontier.length) {
      const level = await prisma.comment.findMany({
        where: { postId, parentCommentId: { in: frontier } },
        orderBy: { createdAt: 'asc' },
        include: { user: true, reactions: true, tags: { include: { user: true } } },
      });
      if (!level.length) break;
      allReplies.push(...level);
      frontier = level.map((c) => c.id);
    }
  }

  // Batch friendStatus for every author on this page in one query instead
  // of one getFriendStatus() call per comment (was N+1).
  const authorIds = [...new Set([...pageRoots, ...allReplies].map((c) => c.userId))];
  const friendStatusByAuthor = new Map<string, string>();
  if (currentUserId && authorIds.length) {
    const followRows = await prisma.follow.findMany({
      where: {
        OR: [
          { followerId: currentUserId, followingId: { in: authorIds } },
          { followerId: { in: authorIds }, followingId: currentUserId },
        ],
      },
      select: { followerId: true, followingId: true },
    });
    const followingSet = new Set(followRows.filter((f) => f.followerId === currentUserId).map((f) => f.followingId));
    const followerSet = new Set(followRows.filter((f) => f.followingId === currentUserId).map((f) => f.followerId));
    for (const id of authorIds) {
      if (id === currentUserId) friendStatusByAuthor.set(id, 'self');
      else {
        const iFollow = followingSet.has(id);
        const theyFollow = followerSet.has(id);
        friendStatusByAuthor.set(id, iFollow && theyFollow ? 'friends' : iFollow ? 'following' : theyFollow ? 'follow_back' : 'none');
      }
    }
  }

  function toDTO(c: any) {
    const myReaction = currentUserId ? c.reactions?.find((r: any) => r.userId === currentUserId) : null;
    return {
      id: c.id,
      content: c.content,
      createdAt: c.createdAt,
      author: toAuthorDTO(c.user),
      friendStatus: friendStatusByAuthor.get(c.userId) ?? 'none',
      reactionCount: c.reactions?.length ?? 0,
      myReaction: myReaction ? myReaction.type : null,
      taggedUsers: c.tags?.map((t: any) => toAuthorDTO(t.user)) ?? [],
      replies: [] as any[],
    };
  }

  const nodes = new Map<string, any>();
  for (const c of [...pageRoots, ...allReplies]) nodes.set(c.id, toDTO(c));
  for (const c of allReplies) {
    const parent = nodes.get(c.parentCommentId);
    if (parent) parent.replies.push(nodes.get(c.id));
  }

  const result = pageRoots.map((r) => nodes.get(r.id));
  const last = pageRoots[pageRoots.length - 1];

  return {
    comments: result,
    pagination: {
      hasMore,
      nextCursor: hasMore && last ? encodeCommentCursor(last.createdAt, last.id) : null,
    },
  };
}

export async function setCommentReaction(userId: string, commentId: string, type: string) {
  const comment = await prisma.comment.findUnique({ where: { id: commentId } });
  if (!comment) throw new ApiError(404, 'COMMENT_NOT_FOUND', 'Comment not found.');

  let result: { reaction: string | null; reactionCount: number; shouldNotify: boolean } | null = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      result = await prisma.$transaction(async (tx) => {
        const existing = await tx.commentReaction.findUnique({
          where: { userId_commentId: { userId, commentId } },
        });

        if (existing && existing.type === type) {
          await tx.commentReaction.delete({ where: { id: existing.id } });
          const count = await tx.commentReaction.count({ where: { commentId } });
          return { reaction: null, reactionCount: count, shouldNotify: false };
        }

        await tx.commentReaction.upsert({
          where: { userId_commentId: { userId, commentId } },
          update: { type: type as any },
          create: { userId, commentId, type: type as any },
        });

        const count = await tx.commentReaction.count({ where: { commentId } });
        return { reaction: type, reactionCount: count, shouldNotify: !existing };
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });

      break;
    } catch (err: any) {
      const retryable = err?.code === 'P2034' || err?.code === 'P2002';
      if (!retryable || attempt === 3) throw err;
    }
  }

  if (!result) throw new ApiError(500, 'COMMENT_REACTION_FAILED', 'Could not update comment reaction.');

  if (result.shouldNotify) {
    await createNotification({
      userId: comment.userId,
      actorId: userId,
      type: 'comment_like',
      postId: comment.postId,
      commentId,
      reaction: type,
    });
  }

  return {
    reaction: result.reaction,
    reactionCount: result.reactionCount,
  };
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

export async function reportComment(userId: string, commentId: string, reason: string = 'other', details?: string) {
  const comment = await prisma.comment.findUnique({ where: { id: commentId } });
  if (!comment) throw new ApiError(404, 'COMMENT_NOT_FOUND', 'Comment not found.');

  const existing = await prisma.commentReport.findUnique({
    where: { commentId_reporterId: { commentId, reporterId: userId } },
  });
  if (existing) throw new ApiError(400, 'ALREADY_REPORTED', 'You have already reported this comment.');

  await prisma.commentReport.create({
    data: { commentId, reporterId: userId, reason: reason as any, details },
  });
  return { reported: true };
}
