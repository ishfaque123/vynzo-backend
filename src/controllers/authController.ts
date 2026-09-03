import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../utils/ApiResponse';
import { googleLoginSchema } from '../utils/validators/authValidators';
import { loginWithGoogle } from '../services/authService';
import { toPrivateProfile } from '../services/userService';
import { prisma } from '../config/prisma';

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'none' as const,
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

export async function googleLogin(req: Request, res: Response, next: NextFunction) {
  try {
    const { idToken } = googleLoginSchema.parse(req.body);
    const { token, user, isNewUser } = await loginWithGoogle(idToken);

    res.cookie('vynzo_token', token, COOKIE_OPTIONS);
    sendSuccess(res, { user: toPrivateProfile(user), isNewUser });
  } catch (err) {
    next(err);
  }
}

export async function getMe(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    sendSuccess(res, { user: toPrivateProfile(user) });
  } catch (err) {
    next(err);
  }
}

export async function logout(_req: Request, res: Response) {
  res.clearCookie('vynzo_token', { secure: true, sameSite: 'none' as const });
  sendSuccess(res, { loggedOut: true });
}
