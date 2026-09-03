import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';

export async function toggleLike(userId: string, postId: string) {
  const post = await prisma.post.findUnique({ where: { id: postId } });
  if (!post) throw new ApiError(404, 'POST_NOT_FOUND', 'Post not found.');

  const existing = await prisma.like.findUnique({
    where: { userId_postId: { userId, postId } },
  });

  if (existing) {
    await prisma.like.delete({ where: { id: existing.id } });
    const count = await prisma.like.count({ where: { postId } });
    return { liked: false, likeCount: count };
  } else {
    await prisma.like.create({ data: { userId, postId } });
    const count = await prisma.like.count({ where: { postId } });
    return { liked: true, likeCount: count };
  }
}
