import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware';
import { optionalAuth } from '../middleware/optionalAuth';
import { createPostHandler, getFeedHandler, deletePostHandler, toggleLikeHandler } from '../controllers/postController';

const router = Router();

router.get('/', optionalAuth, getFeedHandler);
router.post('/', authMiddleware, createPostHandler);
router.delete('/:id', authMiddleware, deletePostHandler);
router.post('/:id/like', authMiddleware, toggleLikeHandler);

export default router;
