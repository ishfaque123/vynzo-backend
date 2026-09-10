import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware';
import { blockUserHandler, unblockUserHandler, getBlockStatusHandler } from '../controllers/blockController';

const router = Router();
router.post('/:userId', authMiddleware, blockUserHandler);
router.delete('/:userId', authMiddleware, unblockUserHandler);
router.get('/:userId/status', authMiddleware, getBlockStatusHandler);

export default router;
