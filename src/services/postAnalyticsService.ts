import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';

export async function recordPostView(userId: string, postId: string) {
  const post = await prisma.post.findUnique({ where: { id: postId }, select: { id: true } });
  if (!post) throw new ApiError(404, 'POST_NOT_FOUND', 'Post not found.');
  await prisma.postView.upsert({
    where: { postId_viewerId: { postId, viewerId: userId } },
    update: {},
    create: { postId, viewerId: userId },
  });
  const viewCount = await prisma.postView.count({ where: { postId } });
  return { viewed: true, viewCount };
}
