import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware';
import { toggleFollowHandler, getFollowCountsHandler } from '../controllers/followController';

const router = Router();
router.post('/:userId', authMiddleware, toggleFollowHandler);
router.get('/:userId/counts', getFollowCountsHandler);

export default router;
