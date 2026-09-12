import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware';
import {
  blockUserHandler,
  unblockUserHandler,
  getBlockStatusHandler,
  getBlockedUsersHandler,
  hideBlockedEntriesHandler,
} from '../controllers/blockController';

const router = Router();
router.get('/', authMiddleware, getBlockedUsersHandler);
router.post('/hide', authMiddleware, hideBlockedEntriesHandler);
router.post('/:userId', authMiddleware, blockUserHandler);
router.delete('/:userId', authMiddleware, unblockUserHandler);
router.get('/:userId/status', authMiddleware, getBlockStatusHandler);

export default router;
