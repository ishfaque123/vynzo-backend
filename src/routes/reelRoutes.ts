import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware';
import { reelUpload } from '../middleware/reelUpload';
import {
  getReelsConfigHandler,
  createReelHandler,
  getReelFeedHandler,
  toggleReelLikeHandler,
  toggleReelFavoriteHandler,
  getMyFavoriteReelsHandler,
  deleteReelHandler,
  getMyReelStatusHandler,
  addReelCommentHandler,
  getReelCommentsHandler,
  toggleReelCommentReactionHandler,
  editReelCommentHandler,
  reportReelCommentHandler,
  deleteReelCommentHandler,
} from '../controllers/reelController';

const router = Router();
router.get('/config', getReelsConfigHandler);
router.get('/', authMiddleware, getReelFeedHandler);
router.get('/me/status', authMiddleware, getMyReelStatusHandler);
router.get('/me/favorites', authMiddleware, getMyFavoriteReelsHandler);
router.post('/', authMiddleware, reelUpload.single('video'), createReelHandler);
router.post('/:id/like', authMiddleware, toggleReelLikeHandler);
router.post('/:id/favorite', authMiddleware, toggleReelFavoriteHandler);
router.delete('/:id', authMiddleware, deleteReelHandler);
router.get('/:id/comments', authMiddleware, getReelCommentsHandler);
router.post('/:id/comments', authMiddleware, addReelCommentHandler);
router.post('/comments/:commentId/reaction', authMiddleware, toggleReelCommentReactionHandler);
router.put('/comments/:commentId', authMiddleware, editReelCommentHandler);
router.post('/comments/:commentId/report', authMiddleware, reportReelCommentHandler);
router.delete('/comments/:commentId', authMiddleware, deleteReelCommentHandler);

export default router;
