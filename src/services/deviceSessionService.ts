import crypto from 'crypto';
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
  city?: string;
  country?: string;
}

// Cloudflare sends these visitor-location headers when the site sits
// behind it (the app already trusts the proxy, and userController reads
// cf-ipcountry the same way for profile country). They only ever feed the
// device list's display label — both DB fields are optional — so when the
// headers are missing the location simply stays unknown, exactly like a
// failed geo lookup did before. (This replaced geoip-lite: a ~115 MB
// in-memory database loaded at startup for this one label.)
function parseCountryHeader(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const code = raw.trim().toUpperCase();
  // Cloudflare uses XX for "unknown" and T1 for Tor — neither is a place.
  if (!/^[A-Z]{2}$/.test(code) || code === 'XX' || code === 'T1') return undefined;
  return code;
}

function parseCityHeader(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  let city = raw.trim();
  try { city = decodeURIComponent(city); } catch { /* keep the raw value */ }
  city = city.trim().slice(0, 100);
  return city || undefined;
}

// Pulls the real client IP + browser string off an Express request so callers
// don't need to know about proxy headers.
export function extractRequestMeta(req: { headers: any; ip?: string; socket?: any }): RequestMeta {
  const userAgent = (req.headers['user-agent'] as string) || undefined;
  const forwarded = req.headers['x-forwarded-for'] as string | undefined;
  const ipAddress = forwarded ? forwarded.split(',')[0].trim() : req.ip || req.socket?.remoteAddress || undefined;
  const country = parseCountryHeader(req.headers['cf-ipcountry']);
  const city = parseCityHeader(req.headers['cf-ipcity']);
  return { userAgent, ipAddress, city, country };
}

function lookupLocation(meta?: RequestMeta): { city: string | null; country: string | null } {
  return { city: meta?.city ?? null, country: meta?.country ?? null };
}

export async function getOrCreateDeviceSession(rawToken?: string, meta?: RequestMeta) {
  const now = new Date();

  if (rawToken) {
    const tokenHash = hashToken(rawToken);

    const existing = await prisma.deviceSession.findUnique({
      where: { tokenHash },
    });

    if (existing && existing.expiresAt > now) {
      const { city, country } = lookupLocation(meta);
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
  const { city, country } = lookupLocation(meta);

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
