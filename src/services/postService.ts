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
  return {
    id: post.id,
    content: post.content,
    imageUrl: post.imageUrl,
    visibility: post.visibility,
    createdAt: post.createdAt,
    likeCount: post._count?.likes ?? 0,
    likedByMe: currentUserId
      ? post.likes?.some((l: any) => l.userId === currentUserId) ?? false
      : false,
    author: toAuthorDTO(post.user),
    taggedUsers: post.tags?.map((t: any) => toAuthorDTO(t.user)) ?? [],
    originalPost: post.originalPost ? toPostDTO(post.originalPost, currentUserId) : null,
  };
}

const includeShape = {
  user: true,
  _count: { select: { likes: true } },
  likes: true,
  tags: { include: { user: true } },
  originalPost: {
    include: {
      user: true,
      _count: { select: { likes: true } },
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

export async function getPostById(postId: string, currentUserId?: string) {
  const post = await prisma.post.findUnique({ where: { id: postId }, include: includeShape });
  if (!post) throw new ApiError(404, 'POST_NOT_FOUND', 'Post not found.');
  return toPostDTO(post, currentUserId);
}

export async function deletePost(userId: string, postId: string) {
  const post = await prisma.post.findUnique({ where: { id: postId } });
  if (!post) throw new ApiError(404, 'POST_NOT_FOUND', 'Post not found.');
  if (post.userId !== userId) throw new ApiError(403, 'FORBIDDEN', 'Not your post.');
  await prisma.post.delete({ where: { id: postId } });
}
