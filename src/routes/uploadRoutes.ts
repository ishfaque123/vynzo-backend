import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware';
import { upload } from '../middleware/upload';
import { uploadAvatarHandler, uploadCoverHandler } from '../controllers/uploadController';

const router = Router();
router.post('/avatar', authMiddleware, upload.single('image'), uploadAvatarHandler);
router.post('/cover', authMiddleware, upload.single('image'), uploadCoverHandler);

export default router;
