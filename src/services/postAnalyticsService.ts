import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';

export async function recordPostView(userId: string, postId: string, watchSec: number = 0) {
  const post = await prisma.post.findUnique({ where: { id: postId }, select: { id: true } });
  if (!post) throw new ApiError(404, 'POST_NOT_FOUND', 'Post not found.');
  const ws = Math.max(0, Math.min(3600, Math.floor(Number(watchSec) || 0)));
  await prisma.postView.upsert({
    where: { postId_viewerId: { postId, viewerId: userId } },
    update: { watchSec: { increment: ws } },
    create: { postId, viewerId: userId, watchSec: ws },
  });
  const viewCount = await prisma.postView.count({ where: { postId } });
  return { viewed: true, viewCount };
}
