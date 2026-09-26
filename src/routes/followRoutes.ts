import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware';
import { optionalAuth } from '../middleware/optionalAuth';
import { toggleFollowHandler, getFollowCountsHandler, getFollowStatusHandler, getFollowUsersHandler } from '../controllers/followController';

const router = Router();
router.post('/:userId', authMiddleware, toggleFollowHandler);
router.get('/:userId/counts', getFollowCountsHandler);
router.get('/:userId/status', optionalAuth, getFollowStatusHandler);
router.get('/:userId/:direction', optionalAuth, (req, res, next) => {
  if (req.params.direction !== 'followers' && req.params.direction !== 'following') {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Not found.' } });
    return;
  }
  getFollowUsersHandler(req, res, next);
});

export default router;
