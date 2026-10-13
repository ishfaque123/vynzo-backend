import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../utils/ApiResponse';
import {
  getNotifications,
  markAllRead,
  getUnreadCount,
  deleteNotifications,
  deleteAllNotifications,
  getPreferences,
  setPreference,
} from '../services/notificationService';

export async function getNotificationsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const notifications = await getNotifications(req.user!.id);
    sendSuccess(res, { notifications });
  } catch (err) {
    next(err);
  }
}

export async function markAllReadHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await markAllRead(req.user!.id);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

export async function getUnreadCountHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await getUnreadCount(req.user!.id);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

export async function deleteNotificationsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id: unknown) => typeof id === 'string') : [];
    const result = await deleteNotifications(req.user!.id, ids);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

export async function deleteAllNotificationsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await deleteAllNotifications(req.user!.id);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

export async function getPreferencesHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const preferences = await getPreferences(req.user!.id);
    sendSuccess(res, { preferences });
  } catch (err) {
    next(err);
  }
}

export async function setPreferenceHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { category, enabled } = req.body;
    if (typeof category !== 'string' || typeof enabled !== 'boolean') {
      return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'category (string) and enabled (boolean) are required.' } });
    }
    const preference = await setPreference(req.user!.id, category, enabled);
    sendSuccess(res, { preference: { category: preference.category, enabled: !!preference.enabled } });
  } catch (err: any) {
    if (err.message === 'INVALID_CATEGORY') {
      return res.status(400).json({ success: false, error: { code: 'INVALID_CATEGORY', message: 'Unknown preference category.' } });
    }
    next(err);
  }
}
