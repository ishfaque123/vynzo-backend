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

export const SHARE_CHANNELS = ['copy', 'whatsapp', 'whatsapp_status', 'messenger', 'facebook', 'facebook_story', 'sms', 'dm'] as const;
export type ShareChannel = (typeof SHARE_CHANNELS)[number];

export async function recordShareEvent(targetType: 'post' | 'reel', targetId: string, channel: string, userId?: string) {
  if (!SHARE_CHANNELS.includes(channel as ShareChannel)) throw new ApiError(400, 'INVALID_CHANNEL', 'Unknown share channel.');
  // Only real targets count; a missing target is a client bug, not a share.
  const exists = targetType === 'post'
    ? await prisma.post.findUnique({ where: { id: targetId }, select: { id: true } })
    : await prisma.reel.findUnique({ where: { id: targetId }, select: { id: true } });
  if (!exists) throw new ApiError(404, 'TARGET_NOT_FOUND', 'Shared item not found.');
  await prisma.shareEvent.create({ data: { targetType, targetId, channel, userId: userId ?? null } });
  return true;
}

export async function getShareEventCounts(targetType: 'post' | 'reel', targetIds: string[]): Promise<Map<string, number>> {
  if (!targetIds.length) return new Map();
  try {
    const rows = await prisma.shareEvent.groupBy({
      by: ['targetId'],
      where: { targetType, targetId: { in: [...new Set(targetIds)] } },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.targetId, r._count._all]));
  } catch {
    return new Map();
  }
}

export async function createShareLink(targetType: 'profile' | 'post' | 'reel', targetId: string) {
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

  if (link.targetType === 'reel') {
    const reel = await prisma.reel.findUnique({ where: { id: link.targetId }, select: { id: true } });
    if (!reel) throw new ApiError(404, 'LINK_NOT_FOUND', 'This link is invalid or has expired.');
    return { type: 'reel' as const, reelId: reel.id };
  }

  const post = await prisma.post.findUnique({ where: { id: link.targetId }, select: { id: true } });
  if (!post) throw new ApiError(404, 'LINK_NOT_FOUND', 'This link is invalid or has expired.');
  return { type: 'post' as const, postId: post.id };
}
