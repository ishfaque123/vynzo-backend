import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../utils/ApiResponse';
import { getNotifications, markAllRead, getUnreadCount } from '../services/notificationService';

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
