import { prisma } from '../config/prisma';
import { getGoogleUserFromCode, getGoogleUserFromIdToken } from '../config/googleAuth';
import { signToken } from '../utils/jwt';
import { getOrCreateDeviceSession, getDeviceSession, RequestMeta } from './deviceSessionService';
import { createNotification } from './notificationService';
import { ApiError } from '../middleware/errorHandler';

async function loginWithGoogleIdentity(
  googleId: string,
  email?: string,
  deviceToken?: string,
  meta?: RequestMeta,
) {
  let user = await prisma.user.findUnique({ where: { googleId } });
  let isNewUser = false;

  if (!user && email) {
    const emailUser = await prisma.user.findUnique({ where: { email } });
    if (emailUser) {
      if (emailUser.googleId && emailUser.googleId !== googleId) {
        throw new ApiError(409, 'EMAIL_ALREADY_LINKED', 'This email is already linked to another account.');
      }
      user = await prisma.user.update({
        where: { id: emailUser.id },
        data: { googleId, lastActiveAt: new Date() },
      });
    }
  }

  if (!user) {
    user = await prisma.user.create({ data: { googleId, email: email || null } });
    isNewUser = true;
  } else {
    if (user.accountStatus !== 'active') {
      throw new ApiError(403, 'ACCOUNT_NOT_ACTIVE', 'This account is not active.');
    }
    user = await prisma.user.update({
      where: { id: user.id },
      data: { ...(email && !user.email ? { email } : {}), lastActiveAt: new Date() },
    });
  }

  const device = await getOrCreateDeviceSession(deviceToken, meta);

  const existingAccountSession = await prisma.accountSession.findUnique({
    where: {
      deviceSessionId_userId: {
        deviceSessionId: device.session.id,
        userId: user.id,
      },
    },
  });

  const accountSession = await prisma.accountSession.upsert({
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

  const token = signToken({ userId: user.id, accountSessionId: accountSession.id });

  return {
    token,
    user,
    isNewUser,
    deviceToken: device.rawToken,
  };
}

export async function loginWithGoogleCode(code: string, deviceToken?: string, meta?: RequestMeta) {
  const { googleId, email } = await getGoogleUserFromCode(code);
  return loginWithGoogleIdentity(googleId, email, deviceToken, meta);
}

export async function loginWithGoogleIdToken(
  idToken: string,
  nonce: string,
  deviceToken?: string,
  meta?: RequestMeta,
) {
  const { googleId, email } = await getGoogleUserFromIdToken(idToken, nonce);
  return loginWithGoogleIdentity(googleId, email, deviceToken, meta);
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

  const updated = await prisma.accountSession.update({
    where: { id: account.id },
    data: { lastUsedAt: now },
  });

  await prisma.user.update({
    where: { id: account.user.id },
    data: { lastActiveAt: now },
  });

  const token = signToken({ userId: account.user.id, accountSessionId: updated.id });

  return { token, user: account.user };
}


export async function loginWithEmail(email: string, deviceToken?: string, meta?: RequestMeta) {
  let user = await prisma.user.findUnique({ where: { email } });
  let isNewUser = false;

  if (!user) {
    user = await prisma.user.create({ data: { email } });
    isNewUser = true;
  } else if (user.accountStatus !== 'active') {
    throw new ApiError(403, 'ACCOUNT_NOT_ACTIVE', 'This account is not active.');
  } else {
    user = await prisma.user.update({
      where: { id: user.id },
      data: { lastActiveAt: new Date() },
    });
  }

  const device = await getOrCreateDeviceSession(deviceToken, meta);
  const existingAccountSession = await prisma.accountSession.findUnique({
    where: { deviceSessionId_userId: { deviceSessionId: device.session.id, userId: user.id } },
  });

  const accountSession = await prisma.accountSession.upsert({
    where: { deviceSessionId_userId: { deviceSessionId: device.session.id, userId: user.id } },
    create: { deviceSessionId: device.session.id, userId: user.id },
    update: { lastUsedAt: new Date() },
  });

  if (!isNewUser && !existingAccountSession) {
    await createNotification({ userId: user.id, actorId: null, type: 'new_device_login' });
  }

  return {
    token: signToken({ userId: user.id, accountSessionId: accountSession.id }),
    user,
    isNewUser,
    deviceToken: device.rawToken,
  };
}
