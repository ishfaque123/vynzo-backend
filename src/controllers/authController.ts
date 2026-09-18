import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../utils/ApiResponse';
import { switchAccountSchema } from '../utils/validators/authValidators';
import {
  loginWithGoogleCode,
  loginWithGoogleIdToken,
  getSavedAccounts,
  switchAccount,
  loginWithEmail,
} from '../services/authService';
import { requestEmailVerification, consumeEmailVerification } from '../services/emailVerificationService';
import { extractRequestMeta } from '../services/deviceSessionService';
import { getGoogleAuthUrl } from '../config/googleAuth';
import { toPrivateProfile } from '../services/userService';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { ApiError } from '../middleware/errorHandler';
import { logAuthFailure } from '../services/authFailureLogService';

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

function clearAuthCookies(res: Response) {
  res.clearCookie('vynzo_token', { secure: true, sameSite: 'none' as const });
  res.clearCookie('vynzo_token', { secure: true, sameSite: 'none' as const, domain: '.frianzo.online' });
  res.clearCookie('vynzo_device', { secure: true, sameSite: 'none' as const });
  res.clearCookie('vynzo_device', { secure: true, sameSite: 'none' as const, domain: '.frianzo.online' });
}

export async function googleLoginStart(req: Request, res: Response) {
  const forceSelect = req.query.switch === '1';
  const mobileApp = req.query.app === '1';
  res.redirect(getGoogleAuthUrl(forceSelect, mobileApp));
}

export async function googleCallback(req: Request, res: Response) {
  const code = req.query.code as string | undefined;
  const mobileApp = req.query.state === 'frianzo_mobile';

  if (!code) {
    if (mobileApp) {
      return res.redirect('frianzo://oauth/callback?error=google_auth_failed');
    }
    return res.redirect(`${env.frontendUrl}/login?error=google_auth_failed`);
  }

  try {
    const meta = extractRequestMeta(req);
    const result = await loginWithGoogleCode(code, req.cookies?.vynzo_device, meta);

    if (mobileApp) {
      const params = new URLSearchParams({
        token: result.token,
        device: result.deviceToken,
        newUser: result.isNewUser ? '1' : '0',
      });
      return res.redirect(`frianzo://oauth/callback?${params.toString()}`);
    }

    clearAuthCookies(res);
    res.cookie('vynzo_token', result.token, COOKIE_OPTIONS);
    res.cookie('vynzo_device', result.deviceToken, DEVICE_COOKIE_OPTIONS);

    res.redirect(`${env.frontendUrl}${result.isNewUser ? '/profile-setup' : '/'}`);
  } catch (err) {
    await logAuthFailure({
      platform: mobileApp ? 'webview' : 'web',
      stage: 'google_callback',
      code: err instanceof ApiError ? err.code : 'GOOGLE_AUTH_FAILED',
      message: err instanceof Error ? err.message : 'Google authentication failed.',
      userAgent: req.get('user-agent'),
      ipAddress: req.ip,
    });
    if (mobileApp) {
      return res.redirect('frianzo://oauth/callback?error=google_auth_failed');
    }
    res.redirect(`${env.frontendUrl}/login?error=google_auth_failed`);
  }
}

export function googleNativeConfig(_req: Request, res: Response) {
  return sendSuccess(res, { clientId: env.googleClientId });
}

export async function googleNativeLogin(req: Request, res: Response, next: NextFunction) {
  try {
    const { idToken, nonce, deviceToken } = req.body as {
      idToken?: string;
      nonce?: string;
      deviceToken?: string;
    };

    if (!idToken || !nonce) {
      throw new ApiError(400, 'GOOGLE_CREDENTIAL_REQUIRED', 'Google credential is required.');
    }

    const meta = extractRequestMeta(req);
    const result = await loginWithGoogleIdToken(
      idToken,
      nonce,
      deviceToken,
      meta,
    );

    return sendSuccess(res, {
      token: result.token,
      deviceToken: result.deviceToken,
      isNewUser: result.isNewUser,
    });
  } catch (err) {
    await logAuthFailure({
      platform: 'android',
      stage: 'google_native_login',
      code: err instanceof ApiError ? err.code : 'GOOGLE_NATIVE_LOGIN_FAILED',
      message: err instanceof Error ? err.message : 'Google native authentication failed.',
      email: typeof req.body?.email === 'string' ? req.body.email : undefined,
      appVersion: req.get('x-app-version'),
      userAgent: req.get('user-agent'),
      ipAddress: req.ip,
    });
    next(err);
  }
}


export async function requestEmailCode(req: Request, res: Response, next: NextFunction) {
  try {
    const { email } = req.body as { email?: string };
    if (!email) throw new ApiError(400, 'EMAIL_REQUIRED', 'Email is required.');
    await requestEmailVerification(email);
    return sendSuccess(res, { sent: true });
  } catch (err) {
    next(err);
  }
}

export async function verifyEmailCode(req: Request, res: Response, next: NextFunction) {
  try {
    const { email, code, deviceToken } = req.body as {
      email?: string;
      code?: string;
      deviceToken?: string;
    };
    if (!email || !code) {
      throw new ApiError(400, 'VERIFICATION_REQUIRED', 'Email and verification code are required.');
    }

    const verifiedEmail = await consumeEmailVerification(email, code);
    const meta = extractRequestMeta(req);
    const result = await loginWithEmail(verifiedEmail, deviceToken || req.cookies?.vynzo_device, meta);

    clearAuthCookies(res);
    res.cookie('vynzo_token', result.token, COOKIE_OPTIONS);
    res.cookie('vynzo_device', result.deviceToken, DEVICE_COOKIE_OPTIONS);

    return sendSuccess(res, {
      user: toPrivateProfile(result.user),
      isNewUser: result.isNewUser,
      deviceToken: result.deviceToken,
    });
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

export async function getAccounts(req: Request, res: Response, next: NextFunction) {
  try {
    const accounts = await getSavedAccounts(req.cookies?.vynzo_device);
    sendSuccess(res, { accounts });
  } catch (err) {
    next(err);
  }
}

export async function switchSavedAccount(req: Request, res: Response, next: NextFunction) {
  try {
    const { accountId } = switchAccountSchema.parse(req.body);
    const result = await switchAccount(accountId, req.cookies?.vynzo_device);

    res.clearCookie('vynzo_token', { secure: true, sameSite: 'none' as const });
    res.clearCookie('vynzo_token', { secure: true, sameSite: 'none' as const, domain: '.frianzo.online' });
    res.cookie('vynzo_token', result.token, COOKIE_OPTIONS);
    sendSuccess(res, { user: toPrivateProfile(result.user) });
  } catch (err) {
    next(err);
  }
}

export async function savePublicKeyHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { publicKey } = req.body as { publicKey?: string };
    if (!publicKey) throw new ApiError(400, 'NO_KEY', 'publicKey is required.');
    await prisma.user.update({ where: { id: req.user!.id }, data: { publicKey } });
    sendSuccess(res, { saved: true });
  } catch (err) {
    next(err);
  }
}

export async function logout(_req: Request, res: Response) {
  clearAuthCookies(res);
  sendSuccess(res, { loggedOut: true });
}
