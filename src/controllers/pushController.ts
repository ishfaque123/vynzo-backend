import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../utils/ApiResponse';
import { registerPushToken, removePushToken } from '../services/pushService';

function readToken(req: Request): string {
  const t = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  return t.length > 0 && t.length <= 255 ? t : '';
}

export async function registerPushTokenHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const token = readToken(req);
    if (!token) {
      res.status(400).json({ success: false, error: { message: 'Invalid token' } });
      return;
    }
    await registerPushToken(req.user!.id, token);
    sendSuccess(res, { registered: true });
  } catch (err) {
    next(err);
  }
}

export async function removePushTokenHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const token = readToken(req);
    if (token) await removePushToken(req.user!.id, token);
    sendSuccess(res, { removed: true });
  } catch (err) {
    next(err);
  }
}
