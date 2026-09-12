import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../utils/ApiResponse';
import { switchAccountSchema } from '../utils/validators/authValidators';
import {
  loginWithGoogleCode,
  getSavedAccounts,
  switchAccount,
} from '../services/authService';
import { extractRequestMeta } from '../services/deviceSessionService';
import { getGoogleAuthUrl } from '../config/googleAuth';
import { toPrivateProfile } from '../services/userService';
import { prisma } from '../config/prisma';
import { env } from '../config/env';

// No `domain` attribute — the backend is served from Railway's own domain
// (via the api.frianzo.online custom domain), not frianzo.online itself.
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

// An older version of this code set cookies with `domain: '.frianzo.online'`.
// Any browser that ever received one of those still has it stored. Clearing
// with today's (no-domain) options only removes the host-only variant, so a
// leftover `.frianzo.online`-scoped cookie can stick around and get sent
// alongside the new one — the browser then may present the OLD, stale token
// to the backend instead of the fresh one, which looks exactly like "every
// Gmail account I pick logs me into the same old account." Clearing BOTH
// variants on every login/switch/logout guarantees no old cookie survives.
function clearAuthCookies(res: Response) {
  res.clearCookie('vynzo_token', { secure: true, sameSite: 'none' as const });
  res.clearCookie('vynzo_token', { secure: true, sameSite: 'none' as const, domain: '.frianzo.online' });
  res.clearCookie('vynzo_device', { secure: true, sameSite: 'none' as const });
  res.clearCookie('vynzo_device', { secure: true, sameSite: 'none' as const, domain: '.frianzo.online' });
}

export async function googleLoginStart(req: Request, res: Response) {
  const forceSelect = req.query.switch === '1';
  res.redirect(getGoogleAuthUrl(forceSelect));
}

export async function googleCallback(req: Request, res: Response) {
  const code = req.query.code as string | undefined;

  if (!code) {
    return res.redirect(`${env.frontendUrl}/login?error=google_auth_failed`);
  }

  try {
    const meta = extractRequestMeta(req);
    const result = await loginWithGoogleCode(code, req.cookies?.vynzo_device, meta);

    clearAuthCookies(res);
    res.cookie('vynzo_token', result.token, COOKIE_OPTIONS);
    res.cookie('vynzo_device', result.deviceToken, DEVICE_COOKIE_OPTIONS);

    res.redirect(`${env.frontendUrl}${result.isNewUser ? '/profile-setup' : '/'}`);
  } catch (err) {
    res.redirect(`${env.frontendUrl}/login?error=google_auth_failed`);
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

export async function logout(_req: Request, res: Response) {
  clearAuthCookies(res);
  // vynzo_device intentionally kept — saved accounts belong to this device.
  sendSuccess(res, { loggedOut: true });
}
