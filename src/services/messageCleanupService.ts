import { prisma } from '../config/prisma';

const MESSAGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export async function cleanupExpiredMessages() {
  const cutoff = new Date(Date.now() - MESSAGE_RETENTION_MS);

  const result = await prisma.message.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });

  // Disappearing messages whose timer elapsed.
  const expired = await prisma.message.deleteMany({
    where: { expiresAt: { lte: new Date() } },
  });

  return { deleted: result.count + expired.count };
}
