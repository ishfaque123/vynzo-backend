import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware';
import { createPostHandler, getFeedHandler, deletePostHandler } from '../controllers/postController';

const router = Router();

router.get('/', getFeedHandler);
router.post('/', authMiddleware, createPostHandler);
router.delete('/:id', authMiddleware, deletePostHandler);

export default router;
