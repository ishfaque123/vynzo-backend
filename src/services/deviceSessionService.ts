import crypto from 'crypto';
import geoip from 'geoip-lite';
import { prisma } from '../config/prisma';

const DEVICE_SESSION_DAYS = 30;

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export interface RequestMeta {
  userAgent?: string;
  ipAddress?: string;
}

// Pulls the real client IP + browser string off an Express request so callers
// don't need to know about proxy headers.
export function extractRequestMeta(req: { headers: any; ip?: string; socket?: any }): RequestMeta {
  const userAgent = (req.headers['user-agent'] as string) || undefined;
  const forwarded = req.headers['x-forwarded-for'] as string | undefined;
  const ipAddress = forwarded ? forwarded.split(',')[0].trim() : req.ip || req.socket?.remoteAddress || undefined;
  return { userAgent, ipAddress };
}

function lookupLocation(ip?: string): { city: string | null; country: string | null } {
  if (!ip) return { city: null, country: null };
  const clean = ip.replace('::ffff:', '').split(',')[0].trim();
  const geo = geoip.lookup(clean);
  return { city: geo?.city || null, country: geo?.country || null };
}

export async function getOrCreateDeviceSession(rawToken?: string, meta?: RequestMeta) {
  const now = new Date();

  if (rawToken) {
    const tokenHash = hashToken(rawToken);

    const existing = await prisma.deviceSession.findUnique({
      where: { tokenHash },
    });

    if (existing && existing.expiresAt > now) {
      const { city, country } = lookupLocation(meta?.ipAddress);
      const updated = await prisma.deviceSession.update({
        where: { id: existing.id },
        data: {
          lastUsedAt: now,
          userAgent: meta?.userAgent ?? existing.userAgent,
          ipAddress: meta?.ipAddress ?? existing.ipAddress,
          city: city ?? existing.city,
          country: country ?? existing.country,
        },
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
  const { city, country } = lookupLocation(meta?.ipAddress);

  const session = await prisma.deviceSession.create({
    data: {
      tokenHash,
      expiresAt,
      userAgent: meta?.userAgent,
      ipAddress: meta?.ipAddress,
      city,
      country,
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
