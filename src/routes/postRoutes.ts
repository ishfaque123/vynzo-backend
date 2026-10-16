import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware';
import { optionalAuth } from '../middleware/optionalAuth';
import { upload } from '../middleware/upload';
import { postCreateLimiter } from '../middleware/rateLimiter';
import {
  createPostHandler, getFeedHandler, deletePostHandler, setReactionHandler,
  sharePostHandler, getPostHandler, getUserPostsHandler, updatePostHandler,
  reportPostHandler, hidePostHandler, recordPostViewHandler, togglePinPostHandler,
  getContentMixHandler,
} from '../controllers/postController';

const router = Router();

router.get('/', optionalAuth, getFeedHandler);
router.get('/content-mix', authMiddleware, getContentMixHandler);
router.post('/', authMiddleware, postCreateLimiter, upload.single('image'), createPostHandler);
router.get('/user/:username', optionalAuth, getUserPostsHandler);
router.get('/:id', optionalAuth, getPostHandler);
router.patch('/:id', authMiddleware, updatePostHandler);
router.delete('/:id', authMiddleware, deletePostHandler);
router.post('/:id/reaction', authMiddleware, setReactionHandler);
router.post('/:id/share', authMiddleware, sharePostHandler);
router.post('/:id/report', authMiddleware, reportPostHandler);
router.post('/:id/hide', authMiddleware, hidePostHandler);
router.post('/:id/view', authMiddleware, recordPostViewHandler);
router.post('/:id/pin', authMiddleware, togglePinPostHandler);

export default router;
