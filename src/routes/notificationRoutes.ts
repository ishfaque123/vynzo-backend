import { Router } from 'express';
import { registerPushTokenHandler, removePushTokenHandler } from '../controllers/pushController';
import { authMiddleware } from '../middleware/authMiddleware';
import {
  getNotificationsHandler,
  markAllReadHandler,
  getUnreadCountHandler,
  deleteNotificationsHandler,
  deleteAllNotificationsHandler,
} from '../controllers/notificationController';

const router = Router();
router.get('/', authMiddleware, getNotificationsHandler);
router.get('/unread-count', authMiddleware, getUnreadCountHandler);
router.post('/read-all', authMiddleware, markAllReadHandler);
router.post('/push-token', authMiddleware, registerPushTokenHandler);
router.delete('/push-token', authMiddleware, removePushTokenHandler);
router.delete('/all', authMiddleware, deleteAllNotificationsHandler);
router.delete('/', authMiddleware, deleteNotificationsHandler);

export default router;
