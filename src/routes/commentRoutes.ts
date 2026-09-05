import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware';
import { addCommentHandler, getCommentsHandler, toggleCommentsSettingHandler, deleteCommentHandler, editCommentHandler } from '../controllers/commentController';

const router = Router();
router.get('/:postId', getCommentsHandler);
router.post('/:postId', authMiddleware, addCommentHandler);
router.patch('/:commentId', authMiddleware, editCommentHandler);
router.delete('/:commentId', authMiddleware, deleteCommentHandler);
router.patch('/settings/toggle', authMiddleware, toggleCommentsSettingHandler);

export default router;
