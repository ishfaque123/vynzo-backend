import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';

function toPostDTO(post: any, currentUserId?: string) {
  return {
    id: post.id,
    content: post.content,
    imageUrl: post.imageUrl,
    createdAt: post.createdAt,
    likeCount: post._count?.likes ?? 0,
    likedByMe: currentUserId
      ? post.likes?.some((l: any) => l.userId === currentUserId) ?? false
      : false,
    author: {
      id: post.user.id,
      username: post.user.username,
      displayName: post.user.displayName,
      profilePictureUrl: post.user.profilePictureUrl,
    },
  };
}

export async function createPost(userId: string, content: string) {
  const post = await prisma.post.create({
    data: { userId, content },
    include: { user: true, _count: { select: { likes: true } }, likes: true },
  });
  return toPostDTO(post, userId);
}

export async function getFeed(currentUserId?: string, limit = 20) {
  const posts = await prisma.post.findMany({
    take: limit,
    orderBy: { createdAt: 'desc' },
    include: { user: true, _count: { select: { likes: true } }, likes: true },
  });
  return posts.map((p) => toPostDTO(p, currentUserId));
}

export async function deletePost(userId: string, postId: string) {
  const post = await prisma.post.findUnique({ where: { id: postId } });
  if (!post) throw new ApiError(404, 'POST_NOT_FOUND', 'Post not found.');
  if (post.userId !== userId) throw new ApiError(403, 'FORBIDDEN', 'Not your post.');
  await prisma.post.delete({ where: { id: postId } });
}
