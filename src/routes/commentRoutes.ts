import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware';
import { optionalAuth } from '../middleware/optionalAuth';
import { addCommentHandler, getCommentsHandler, toggleCommentsSettingHandler, deleteCommentHandler, editCommentHandler, setCommentReactionHandler } from '../controllers/commentController';

const router = Router();
router.get('/:postId', optionalAuth, getCommentsHandler);
router.post('/:postId', authMiddleware, addCommentHandler);
router.patch('/:commentId', authMiddleware, editCommentHandler);
router.delete('/:commentId', authMiddleware, deleteCommentHandler);
router.post('/:commentId/reaction', authMiddleware, setCommentReactionHandler);
router.patch('/settings/toggle', authMiddleware, toggleCommentsSettingHandler);

export default router;
