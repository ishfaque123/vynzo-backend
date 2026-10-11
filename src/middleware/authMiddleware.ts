import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../utils/jwt';
import { ApiError } from './errorHandler';
import { prisma } from '../config/prisma';

declare global {
  namespace Express {
    interface Request {
      user?: { id: string; role: string };
    }
  }
}

export async function authMiddleware(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.vynzo_auth_token || req.cookies?.vynzo_token;
    if (!token) {
      throw new ApiError(401, 'NOT_AUTHENTICATED', 'Login required.');
    }

    const payload = verifyToken(token);

    // Tokens issued after the Devices feature carry the account-session id
    // that created them. If that session was remotely logged out, the
    // session row is gone — reject the token even though it hasn't expired.
    if (payload.accountSessionId) {
      const session = await prisma.accountSession.findUnique({ where: { id: payload.accountSessionId } });
      if (!session) {
        throw new ApiError(401, 'SESSION_REVOKED', 'This session has been logged out.');
      }
    }

    const user = await prisma.user.findUnique({ where: { id: payload.userId } });

    if (!user || user.accountStatus !== 'active') {
      throw new ApiError(401, 'NOT_AUTHENTICATED', 'Login required.');
    }

    req.user = { id: user.id, role: user.role };

    // Update daily login streak (fire-and-forget, don't block the request)
    updateLoginStreak(user.id, user.lastLoginDate, user.loginStreak).catch(() => {});

    next();
  } catch {
    next(new ApiError(401, 'NOT_AUTHENTICATED', 'Login required.'));
  }
}

/**
 * Update the user's daily login streak.
 * - First login ever, or last login was before yesterday: streak = 1
 * - Last login was yesterday: streak + 1
 * - Already logged in today: no change
 */
async function updateLoginStreak(userId: string, lastLoginDate: Date | null, currentStreak: number) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (lastLoginDate) {
    const last = new Date(lastLoginDate.getFullYear(), lastLoginDate.getMonth(), lastLoginDate.getDate());
    const diffDays = Math.round((today.getTime() - last.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays === 0) return; // already counted today
    if (diffDays === 1) {
      await prisma.user.update({
        where: { id: userId },
        data: { loginStreak: currentStreak + 1, lastLoginDate: now },
      });
      return;
    }
  }
  // First ever login, or streak broken (missed a day)
  await prisma.user.update({
    where: { id: userId },
    data: { loginStreak: 1, lastLoginDate: now },
  });
}