import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware';
import { getCloseFriendsHandler, addCloseFriendHandler, removeCloseFriendHandler } from '../controllers/closeFriendController';

const router = Router();
router.get('/', authMiddleware, getCloseFriendsHandler);
router.post('/:userId', authMiddleware, addCloseFriendHandler);
router.delete('/:userId', authMiddleware, removeCloseFriendHandler);

export default router;
