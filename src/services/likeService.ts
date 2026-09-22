import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';
import { createNotification } from './notificationService';

type ReactionType = 'like' | 'love' | 'haha' | 'wow' | 'sad' | 'angry';

export async function setReaction(userId: string, postId: string, type: ReactionType) {
  const post = await prisma.post.findUnique({ where: { id: postId } });
  if (!post) throw new ApiError(404, 'POST_NOT_FOUND', 'Post not found.');

  let result: { reaction: ReactionType | null; likeCount: number; shouldNotify: boolean } | null = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      result = await prisma.$transaction(async (tx) => {
        const existing = await tx.like.findUnique({
          where: { userId_postId: { userId, postId } },
        });

        if (existing && existing.type === type) {
          await tx.like.delete({ where: { id: existing.id } });
          const count = await tx.like.count({ where: { postId } });
          return { reaction: null, likeCount: count, shouldNotify: false };
        }

        await tx.like.upsert({
          where: { userId_postId: { userId, postId } },
          update: { type },
          create: { userId, postId, type },
        });

        const count = await tx.like.count({ where: { postId } });
        return { reaction: type, likeCount: count, shouldNotify: !existing };
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });

      break;
    } catch (err: any) {
      const retryable = err?.code === 'P2034' || err?.code === 'P2002';
      if (!retryable || attempt === 3) throw err;
    }
  }

  if (!result) throw new ApiError(500, 'REACTION_FAILED', 'Could not update reaction.');

  if (result.shouldNotify) {
    await createNotification({
      userId: post.userId,
      actorId: userId,
      type: 'post_like',
      postId,
      reaction: type,
    });
  }

  return {
    reaction: result.reaction,
    likeCount: result.likeCount,
  };
}
