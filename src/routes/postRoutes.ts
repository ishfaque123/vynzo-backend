import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware';
import { optionalAuth } from '../middleware/optionalAuth';
import { upload } from '../middleware/upload';
import { createPostHandler, getFeedHandler, deletePostHandler, toggleLikeHandler, sharePostHandler, getPostHandler } from '../controllers/postController';

const router = Router();

router.get('/', optionalAuth, getFeedHandler);
router.post('/', authMiddleware, upload.single('image'), createPostHandler);
router.get('/:id', optionalAuth, getPostHandler);
router.delete('/:id', authMiddleware, deletePostHandler);
router.post('/:id/like', authMiddleware, toggleLikeHandler);
router.post('/:id/share', authMiddleware, sharePostHandler);

export default router;
