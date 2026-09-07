import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../utils/ApiResponse';
import {
  googleLoginSchema,
  switchAccountSchema,
} from '../utils/validators/authValidators';
import {
  loginWithGoogle,
  getSavedAccounts,
  switchAccount,
} from '../services/authService';
import { toPrivateProfile } from '../services/userService';
import { prisma } from '../config/prisma';

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'none' as const,
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

const DEVICE_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'none' as const,
  maxAge: 30 * 24 * 60 * 60 * 1000,
};

export async function googleLogin(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const { idToken } = googleLoginSchema.parse(req.body);

    const result = await loginWithGoogle(
      idToken,
      req.cookies?.vynzo_device,
    );

    res.cookie('vynzo_token', result.token, COOKIE_OPTIONS);
    res.cookie('vynzo_device', result.deviceToken, DEVICE_COOKIE_OPTIONS);

    sendSuccess(res, {
      user: toPrivateProfile(result.user),
      isNewUser: result.isNewUser,
    });
  } catch (err) {
    next(err);
  }
}

export async function getMe(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
    });

    sendSuccess(res, { user: toPrivateProfile(user) });
  } catch (err) {
    next(err);
  }
}

export async function getAccounts(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const accounts = await getSavedAccounts(req.cookies?.vynzo_device);
    sendSuccess(res, { accounts });
  } catch (err) {
    next(err);
  }
}

export async function switchSavedAccount(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const { accountId } = switchAccountSchema.parse(req.body);

    const result = await switchAccount(
      accountId,
      req.cookies?.vynzo_device,
    );

    res.cookie('vynzo_token', result.token, COOKIE_OPTIONS);

    sendSuccess(res, {
      user: toPrivateProfile(result.user),
    });
  } catch (err) {
    next(err);
  }
}

export async function logout(_req: Request, res: Response) {
  res.clearCookie('vynzo_token', {
    secure: true,
    sameSite: 'none' as const,
  });

  // Intentionally keep vynzo_device.
  // Saved accounts belong to this device and must survive logout.

  sendSuccess(res, { loggedOut: true });
}
