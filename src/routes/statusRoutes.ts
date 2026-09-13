import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware';
import { statusUpload } from '../middleware/statusUpload';
import { createStatusHandler, getStatusFeedHandler, viewStatusHandler, getStatusViewersHandler, deleteStatusHandler } from '../controllers/statusController';

const router = Router();
router.get('/', authMiddleware, getStatusFeedHandler);
router.post('/', authMiddleware, statusUpload.single('media'), createStatusHandler);
router.post('/:id/view', authMiddleware, viewStatusHandler);
router.get('/:id/viewers', authMiddleware, getStatusViewersHandler);
router.delete('/:id', authMiddleware, deleteStatusHandler);

export default router;
