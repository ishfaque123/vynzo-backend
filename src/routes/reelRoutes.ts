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

export default router;
