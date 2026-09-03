import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';

function toPostDTO(post: any) {
  return {
    id: post.id,
    content: post.content,
    imageUrl: post.imageUrl,
    createdAt: post.createdAt,
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
    include: { user: true },
  });
  return toPostDTO(post);
}

export async function getFeed(limit = 20) {
  const posts = await prisma.post.findMany({
    take: limit,
    orderBy: { createdAt: 'desc' },
    include: { user: true },
  });
  return posts.map(toPostDTO);
}

export async function deletePost(userId: string, postId: string) {
  const post = await prisma.post.findUnique({ where: { id: postId } });
  if (!post) throw new ApiError(404, 'POST_NOT_FOUND', 'Post not found.');
  if (post.userId !== userId) throw new ApiError(403, 'FORBIDDEN', 'Not your post.');
  await prisma.post.delete({ where: { id: postId } });
}
