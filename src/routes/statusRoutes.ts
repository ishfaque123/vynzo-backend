import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware';
import { upload } from '../middleware/upload';
import { createStatusHandler, getStatusFeedHandler, viewStatusHandler, getStatusViewersHandler, deleteStatusHandler } from '../controllers/statusController';

const router = Router();
router.get('/', authMiddleware, getStatusFeedHandler);
router.post('/', authMiddleware, upload.single('media'), createStatusHandler);
router.post('/:id/view', authMiddleware, viewStatusHandler);
router.get('/:id/viewers', authMiddleware, getStatusViewersHandler);
router.delete('/:id', authMiddleware, deleteStatusHandler);

export default router;
