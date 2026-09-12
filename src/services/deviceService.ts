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

  return accountSessions.map((acc) => {
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
