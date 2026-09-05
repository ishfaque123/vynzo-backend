import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';

function toAuthorDTO(user: any) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    profilePictureUrl: user.profilePictureUrl,
  };
}

function toPostDTO(post: any, currentUserId?: string): any {
  const myLike = currentUserId ? post.likes?.find((l: any) => l.userId === currentUserId) : null;
  return {
    id: post.id,
    content: post.content,
    imageUrl: post.imageUrl,
    visibility: post.visibility,
    commentAudience: post.commentAudience,
    createdAt: post.createdAt,
    likeCount: post._count?.likes ?? 0,
    commentCount: post._count?.comments ?? 0,
    shareCount: post._count?.reposts ?? 0,
    myReaction: myLike ? myLike.type : null,
    author: toAuthorDTO(post.user),
    taggedUsers: post.tags?.map((t: any) => toAuthorDTO(t.user)) ?? [],
    originalPost: post.originalPost ? toPostDTO(post.originalPost, currentUserId) : null,
  };
}

const includeShape = {
  user: true,
  _count: { select: { likes: true, comments: true, reposts: true } },
  likes: true,
  tags: { include: { user: true } },
  originalPost: {
    include: {
      user: true,
      _count: { select: { likes: true, comments: true, reposts: true } },
      likes: true,
      tags: { include: { user: true } },
    },
  },
};

export async function createPost(
  userId: string,
  content: string,
  imageUrl?: string,
  visibility: 'public' | 'private' = 'public',
  taggedUserIds: string[] = []
) {
  const post = await prisma.post.create({
    data: {
      userId,
      content,
      imageUrl,
      visibility,
      tags: { create: taggedUserIds.slice(0, 2).map((id) => ({ userId: id })) },
    },
    include: includeShape,
  });
  return toPostDTO(post, userId);
}

export async function sharePost(userId: string, originalPostId: string, content: string) {
  const original = await prisma.post.findUnique({ where: { id: originalPostId } });
  if (!original) throw new ApiError(404, 'POST_NOT_FOUND', 'Post not found.');
  const post = await prisma.post.create({
    data: { userId, content, originalPostId },
    include: includeShape,
  });
  return toPostDTO(post, userId);
}

export async function getFeed(currentUserId?: string, limit = 20) {
  const posts = await prisma.post.findMany({
    where: { visibility: 'public' },
    take: limit,
    orderBy: { createdAt: 'desc' },
    include: includeShape,
  });
  return posts.map((p) => toPostDTO(p, currentUserId));
}

export async function getPostsByUsername(username: string, currentUserId?: string) {
  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found.');
  const isOwner = currentUserId === user.id;
  const posts = await prisma.post.findMany({
    where: isOwner ? { userId: user.id } : { userId: user.id, visibility: 'public' },
    orderBy: { createdAt: 'desc' },
    include: includeShape,
  });
  return posts.map((p) => toPostDTO(p, currentUserId));
}

export async function getPostById(postId: string, currentUserId?: string) {
  const post = await prisma.post.findUnique({ where: { id: postId }, include: includeShape });
  if (!post) throw new ApiError(404, 'POST_NOT_FOUND', 'Post not found.');
  return toPostDTO(post, currentUserId);
}

export async function updatePost(
  userId: string,
  postId: string,
  data: { content?: string; commentAudience?: 'everyone' | 'followers' | 'only_me' }
) {
  const post = await prisma.post.findUnique({ where: { id: postId } });
  if (!post) throw new ApiError(404, 'POST_NOT_FOUND', 'Post not found.');
  if (post.userId !== userId) throw new ApiError(403, 'FORBIDDEN', 'Not your post.');

  const updated = await prisma.post.update({
    where: { id: postId },
    data,
    include: includeShape,
  });
  return toPostDTO(updated, userId);
}

export async function deletePost(userId: string, postId: string) {
  const post = await prisma.post.findUnique({ where: { id: postId } });
  if (!post) throw new ApiError(404, 'POST_NOT_FOUND', 'Post not found.');
  if (post.userId !== userId) throw new ApiError(403, 'FORBIDDEN', 'Not your post.');
  await prisma.post.delete({ where: { id: postId } });
}
