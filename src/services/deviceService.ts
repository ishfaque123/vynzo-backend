import { prisma } from '../config/prisma';

function describeDevice(ua?: string | null): string {
  if (!ua) return 'Unknown device';

  const isAndroid = /Android/i.test(ua);
  const isIphone = /iPhone/i.test(ua);
  const isIpad = /iPad/i.test(ua);
  const isMac = /Macintosh/i.test(ua);
  const isWindows = /Windows/i.test(ua);
  const isLinux = /Linux/i.test(ua) && !isAndroid;

  let browser = 'Browser';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/OPR\//i.test(ua) || /Opera/i.test(ua)) browser = 'Opera';
  else if (/CriOS/i.test(ua)) browser = 'Chrome';
  else if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) browser = 'Chrome';
  else if (/Firefox\//i.test(ua)) browser = 'Firefox';
  else if (/Safari\//i.test(ua) && /Version\//i.test(ua)) browser = 'Safari';

  let os = 'Unknown';
  if (isAndroid) os = 'Android';
  else if (isIphone) os = 'iPhone';
  else if (isIpad) os = 'iPad';
  else if (isMac) os = 'Mac';
  else if (isWindows) os = 'Windows';
  else if (isLinux) os = 'Linux';

  return `${browser} on ${os}`;
}

export async function listDevices(userId: string, currentDeviceSessionId?: string | null) {
  const accountSessions = await prisma.accountSession.findMany({
    where: { userId },
    include: { deviceSession: true },
    orderBy: { lastUsedAt: 'desc' },
  });

  // Owner rule (2026-11-21): the list shows only devices used within the
  // last 7 days (plus the current device and unexpired sessions) — idle
  // device data is deleted by the daily retention sweep after 7 days.
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const nowDate = new Date();
  const visible = accountSessions.filter((acc) => {
    const ds = acc.deviceSession;
    const isCurrent = !!currentDeviceSessionId && ds.id === currentDeviceSessionId;
    if (isCurrent) return true;
    return ds.expiresAt > nowDate && acc.lastUsedAt >= sevenDaysAgo;
  });

  return visible.map((acc) => {
    const ds = acc.deviceSession;
    const location = [ds.city, ds.country].filter(Boolean).join(', ');
    return {
      id: ds.id,
      label: describeDevice(ds.userAgent),
      location: location || null,
      lastActiveAt: acc.lastUsedAt,
      isCurrent: !!currentDeviceSessionId && ds.id === currentDeviceSessionId,
    };
  });
}

export async function revokeDevice(userId: string, deviceSessionId: string) {
  await prisma.accountSession.deleteMany({
    where: { userId, deviceSessionId },
  });
  return { revoked: true };
}

export async function revokeOtherDevices(userId: string, currentDeviceSessionId?: string | null) {
  await prisma.accountSession.deleteMany({
    where: {
      userId,
      ...(currentDeviceSessionId ? { deviceSessionId: { not: currentDeviceSessionId } } : {}),
    },
  });
  return { revoked: true };
}
