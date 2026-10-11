import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware';
import { optionalAuth } from '../middleware/optionalAuth';
import {
  getHighlightsHandler, createHighlightHandler, deleteHighlightHandler,
  addToHighlightHandler, removeFromHighlightHandler,
} from '../controllers/highlightController';

const router = Router();

router.get('/user/:username', optionalAuth, getHighlightsHandler);
router.post('/', authMiddleware, createHighlightHandler);
router.delete('/:id', authMiddleware, deleteHighlightHandler);
router.post('/:id/items', authMiddleware, addToHighlightHandler);
router.delete('/:id/items/:itemId', authMiddleware, removeFromHighlightHandler);

export default router;
