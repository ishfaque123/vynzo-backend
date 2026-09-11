import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../utils/ApiResponse';
import {
  getNotifications,
  markAllRead,
  getUnreadCount,
  deleteNotifications,
  deleteAllNotifications,
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
