import crypto from 'crypto';
import { prisma } from '../config/prisma';

const DEVICE_SESSION_DAYS = 30;

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export async function getOrCreateDeviceSession(rawToken?: string) {
  const now = new Date();

  if (rawToken) {
    const tokenHash = hashToken(rawToken);

    const existing = await prisma.deviceSession.findUnique({
      where: { tokenHash },
    });

    if (existing && existing.expiresAt > now) {
      const updated = await prisma.deviceSession.update({
        where: { id: existing.id },
        data: { lastUsedAt: now },
      });

      return {
        rawToken,
        session: updated,
        isNew: false,
      };
    }
  }

  const newRawToken = generateToken();
  const tokenHash = hashToken(newRawToken);
  const expiresAt = new Date(
    now.getTime() + DEVICE_SESSION_DAYS * 24 * 60 * 60 * 1000,
  );

  const session = await prisma.deviceSession.create({
    data: {
      tokenHash,
      expiresAt,
    },
  });

  return {
    rawToken: newRawToken,
    session,
    isNew: true,
  };
}

export async function getDeviceSession(rawToken?: string) {
  if (!rawToken) return null;

  const tokenHash = hashToken(rawToken);

  const session = await prisma.deviceSession.findUnique({
    where: { tokenHash },
  });

  if (!session || session.expiresAt <= new Date()) {
    return null;
  }

  return prisma.deviceSession.update({
    where: { id: session.id },
    data: { lastUsedAt: new Date() },
  });
}
