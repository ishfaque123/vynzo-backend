import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware';
import { optionalAuth } from '../middleware/optionalAuth';
import { toggleFollowHandler, getFollowCountsHandler, getFollowStatusHandler } from '../controllers/followController';

const router = Router();
router.post('/:userId', authMiddleware, toggleFollowHandler);
router.get('/:userId/counts', getFollowCountsHandler);
router.get('/:userId/status', optionalAuth, getFollowStatusHandler);

export default router;
