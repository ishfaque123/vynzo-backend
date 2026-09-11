import { prisma } from '../config/prisma';
import { getGoogleUserFromCode } from '../config/googleAuth';
import { signToken } from '../utils/jwt';
import { getOrCreateDeviceSession, getDeviceSession } from './deviceSessionService';
import { createNotification } from './notificationService';
import { ApiError } from '../middleware/errorHandler';

export async function loginWithGoogleCode(code: string, deviceToken?: string) {
  const { googleId, email } = await getGoogleUserFromCode(code);
  console.log('[GOOGLE_LOGIN_DEBUG]', { googleId, email, codePrefix: code.slice(0, 12) });

  let user = await prisma.user.findUnique({ where: { googleId } });
  let isNewUser = false;

  if (!user) {
    user = await prisma.user.create({ data: { googleId } });
    isNewUser = true;
  } else {
    if (user.accountStatus !== 'active') {
      throw new ApiError(403, 'ACCOUNT_NOT_ACTIVE', 'This account is not active.');
    }
    user = await prisma.user.update({
      where: { id: user.id },
      data: { lastActiveAt: new Date() },
    });
  }

  console.log('[GOOGLE_LOGIN_DEBUG] resolved user:', { userId: user.id, isNewUser });

  const device = await getOrCreateDeviceSession(deviceToken);

  const existingAccountSession = await prisma.accountSession.findUnique({
    where: {
      deviceSessionId_userId: {
        deviceSessionId: device.session.id,
        userId: user.id,
      },
    },
  });

  await prisma.accountSession.upsert({
    where: {
      deviceSessionId_userId: {
        deviceSessionId: device.session.id,
        userId: user.id,
      },
    },
    create: {
      deviceSessionId: device.session.id,
      userId: user.id,
    },
    update: {
      lastUsedAt: new Date(),
    },
  });

  if (!isNewUser && !existingAccountSession) {
    await createNotification({
      userId: user.id,
      actorId: null,
      type: 'new_device_login',
    });
  }

  const token = signToken({ userId: user.id });

  return {
    token,
    user,
    isNewUser,
    deviceToken: device.rawToken,
  };
}

export async function getSavedAccounts(deviceToken?: string) {
  const device = await getDeviceSession(deviceToken);
  if (!device) return [];

  const accounts = await prisma.accountSession.findMany({
    where: {
      deviceSessionId: device.id,
      user: { accountStatus: 'active' },
    },
    orderBy: { lastUsedAt: 'desc' },
    include: {
      user: {
        select: {
          id: true,
          username: true,
          displayName: true,
          profilePictureUrl: true,
          profileCompleted: true,
        },
      },
    },
  });

  return accounts.map((account) => account.user);
}

export async function switchAccount(accountId: string, deviceToken?: string) {
  const device = await getDeviceSession(deviceToken);
  if (!device) {
    throw new ApiError(401, 'DEVICE_SESSION_REQUIRED', 'Saved account session not found.');
  }

  const account = await prisma.accountSession.findUnique({
    where: {
      deviceSessionId_userId: {
        deviceSessionId: device.id,
        userId: accountId,
      },
    },
    include: { user: true },
  });

  if (!account || account.user.accountStatus !== 'active') {
    throw new ApiError(403, 'ACCOUNT_NOT_SAVED', 'This account is not saved on this device.');
  }

  const now = new Date();

  await prisma.accountSession.update({
    where: { id: account.id },
    data: { lastUsedAt: now },
  });

  await prisma.user.update({
    where: { id: account.user.id },
    data: { lastActiveAt: now },
  });

  const token = signToken({ userId: account.user.id });

  return { token, user: account.user };
}
