import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware';
import { optionalAuth } from '../middleware/optionalAuth';
import { upload } from '../middleware/upload';
import {
  createPostHandler, getFeedHandler, deletePostHandler, setReactionHandler,
  sharePostHandler, getPostHandler, getUserPostsHandler, updatePostHandler,
  reportPostHandler, hidePostHandler,
} from '../controllers/postController';

const router = Router();

router.get('/', optionalAuth, getFeedHandler);
router.post('/', authMiddleware, upload.single('image'), createPostHandler);
router.get('/user/:username', optionalAuth, getUserPostsHandler);
router.get('/:id', optionalAuth, getPostHandler);
router.patch('/:id', authMiddleware, updatePostHandler);
router.delete('/:id', authMiddleware, deletePostHandler);
router.post('/:id/reaction', authMiddleware, setReactionHandler);
router.post('/:id/share', authMiddleware, sharePostHandler);
router.post('/:id/report', authMiddleware, reportPostHandler);
router.post('/:id/hide', authMiddleware, hidePostHandler);

export default router;
