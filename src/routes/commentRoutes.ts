import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware';
import { addCommentHandler, getCommentsHandler, toggleCommentsSettingHandler } from '../controllers/commentController';

const router = Router();
router.get('/:postId', getCommentsHandler);
router.post('/:postId', authMiddleware, addCommentHandler);
router.patch('/settings/toggle', authMiddleware, toggleCommentsSettingHandler);

export default router;
