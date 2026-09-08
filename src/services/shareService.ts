import { randomBytes } from 'crypto';
import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function generateCode(length = 10): string {
  const bytes = randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i++) {
    code += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return code;
}

export async function createShareLink(targetType: 'profile' | 'post', targetId: string) {
  const existing = await prisma.shareLink.findFirst({ where: { targetType, targetId } });
  if (existing) return existing.code;

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    try {
      const link = await prisma.shareLink.create({ data: { code, targetType, targetId } });
      return link.code;
    } catch (err: any) {
      if (err.code === 'P2002') continue;
      throw err;
    }
  }
  throw new ApiError(500, 'SHARE_LINK_FAILED', 'Could not generate share link.');
}

export async function resolveShareLink(code: string) {
  const link = await prisma.shareLink.findUnique({ where: { code } });
  if (!link) throw new ApiError(404, 'LINK_NOT_FOUND', 'This link is invalid or has expired.');

  if (link.targetType === 'profile') {
    const user = await prisma.user.findUnique({ where: { id: link.targetId }, select: { username: true } });
    if (!user?.username) throw new ApiError(404, 'LINK_NOT_FOUND', 'This link is invalid or has expired.');
    return { type: 'profile' as const, username: user.username };
  }

  const post = await prisma.post.findUnique({ where: { id: link.targetId }, select: { id: true } });
  if (!post) throw new ApiError(404, 'LINK_NOT_FOUND', 'This link is invalid or has expired.');
  return { type: 'post' as const, postId: post.id };
}
