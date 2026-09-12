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
    const token = req.cookies?.vynzo_token;
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
    next();
  } catch {
    next(new ApiError(401, 'NOT_AUTHENTICATED', 'Login required.'));
  }
}
