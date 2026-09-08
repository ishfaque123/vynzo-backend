import { Request, Response, NextFunction } from 'express';
import { sendSuccess, sendError } from '../utils/ApiResponse';
import { loginWithGoogleCode } from '../services/authService';
import { getGoogleAuthUrl } from '../config/googleAuth';
import { toPrivateProfile } from '../services/userService';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { verifyToken } from '../utils/jwt';

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'none' as const,
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

interface SavedAccount {
  userId: string;
  token: string;
}

function readSavedAccounts(req: Request): SavedAccount[] {
  const raw = req.cookies?.vynzo_accounts;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((a) => a && typeof a.userId === 'string' && typeof a.token === 'string');
  } catch {
    return [];
  }
}

function writeSavedAccounts(res: Response, accounts: SavedAccount[]) {
  res.cookie('vynzo_accounts', JSON.stringify(accounts), COOKIE_OPTIONS);
}

function getActiveUserId(req: Request): string | null {
  const token = req.cookies?.vynzo_token as string | undefined;
  if (!token) return null;
  try {
    return verifyToken(token).userId;
  } catch {
    return null;
  }
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
    const { token, user, isNewUser } = await loginWithGoogleCode(code);

    const accounts = readSavedAccounts(req).filter((a) => a.userId !== user.id);
    accounts.push({ userId: user.id, token });
    writeSavedAccounts(res, accounts);

    res.cookie('vynzo_token', token, COOKIE_OPTIONS);
    res.redirect(`${env.frontendUrl}${isNewUser ? '/profile-setup' : '/'}`);
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

export async function listAccounts(req: Request, res: Response) {
  const activeUserId = getActiveUserId(req);
  const saved = readSavedAccounts(req);
  const validAccounts: SavedAccount[] = [];
  const summaries: any[] = [];

  for (const acc of saved) {
    try {
      verifyToken(acc.token);
    } catch {
      continue;
    }
    const user = await prisma.user.findUnique({ where: { id: acc.userId } });
    if (!user) continue;
    validAccounts.push(acc);
    summaries.push({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      profilePictureUrl: user.profilePictureUrl,
      isActive: user.id === activeUserId,
    });
  }

  if (validAccounts.length !== saved.length) {
    writeSavedAccounts(res, validAccounts);
  }

  sendSuccess(res, { accounts: summaries });
}

export async function switchAccount(req: Request, res: Response) {
  const { userId } = req.body as { userId?: string };
  if (!userId) return sendError(res, 400, 'MISSING_USER_ID', 'userId is required.');

  const saved = readSavedAccounts(req);
  const match = saved.find((a) => a.userId === userId);
  if (!match) return sendError(res, 404, 'ACCOUNT_NOT_FOUND', 'Account not found.');

  try {
    verifyToken(match.token);
  } catch {
    const remaining = saved.filter((a) => a.userId !== userId);
    writeSavedAccounts(res, remaining);
    return sendError(res, 401, 'ACCOUNT_EXPIRED', 'This account session has expired. Please log in again.');
  }

  res.cookie('vynzo_token', match.token, COOKIE_OPTIONS);
  sendSuccess(res, { switched: true });
}

export async function removeAccount(req: Request, res: Response) {
  const { userId } = req.body as { userId?: string };
  if (!userId) return sendError(res, 400, 'MISSING_USER_ID', 'userId is required.');

  const saved = readSavedAccounts(req);
  const remaining = saved.filter((a) => a.userId !== userId);
  writeSavedAccounts(res, remaining);

  const activeUserId = getActiveUserId(req);
  if (activeUserId === userId) {
    if (remaining.length > 0) {
      res.cookie('vynzo_token', remaining[0].token, COOKIE_OPTIONS);
    } else {
      res.clearCookie('vynzo_token', { secure: true, sameSite: 'none' as const });
    }
  }

  sendSuccess(res, { removed: true });
}

export async function logout(req: Request, res: Response) {
  const activeUserId = getActiveUserId(req);
  const saved = readSavedAccounts(req);
  const remaining = saved.filter((a) => a.userId !== activeUserId);
  writeSavedAccounts(res, remaining);

  if (remaining.length > 0) {
    res.cookie('vynzo_token', remaining[0].token, COOKIE_OPTIONS);
    return sendSuccess(res, { loggedOut: true, switchedTo: remaining[0].userId });
  }

  res.clearCookie('vynzo_token', { secure: true, sameSite: 'none' as const });
  res.clearCookie('vynzo_accounts', { secure: true, sameSite: 'none' as const });
  sendSuccess(res, { loggedOut: true, switchedTo: null });
}
