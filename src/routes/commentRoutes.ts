import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware';
import { addCommentHandler, getCommentsHandler } from '../controllers/commentController';

const router = Router();
router.get('/:postId', getCommentsHandler);
router.post('/:postId', authMiddleware, addCommentHandler);

export default router;
