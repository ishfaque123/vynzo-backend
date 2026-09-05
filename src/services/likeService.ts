import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';

type ReactionType = 'like' | 'love' | 'haha' | 'wow' | 'sad' | 'angry';

export async function setReaction(userId: string, postId: string, type: ReactionType) {
  const post = await prisma.post.findUnique({ where: { id: postId } });
  if (!post) throw new ApiError(404, 'POST_NOT_FOUND', 'Post not found.');

  const existing = await prisma.like.findUnique({
    where: { userId_postId: { userId, postId } },
  });

  if (existing && existing.type === type) {
    await prisma.like.delete({ where: { id: existing.id } });
    const count = await prisma.like.count({ where: { postId } });
    return { reaction: null, likeCount: count };
  }

  await prisma.like.upsert({
    where: { userId_postId: { userId, postId } },
    update: { type },
    create: { userId, postId, type },
  });
  const count = await prisma.like.count({ where: { postId } });
  return { reaction: type, likeCount: count };
}
