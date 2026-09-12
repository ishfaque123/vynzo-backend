import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware';
import { upload } from '../middleware/upload';
import { chatUpload } from '../middleware/chatUpload';
import { uploadAvatarHandler, uploadCoverHandler, uploadChatMediaHandler } from '../controllers/uploadController';

const router = Router();
router.post('/avatar', authMiddleware, upload.single('image'), uploadAvatarHandler);
router.post('/cover', authMiddleware, upload.single('image'), uploadCoverHandler);
router.post('/chat', authMiddleware, chatUpload.single('file'), uploadChatMediaHandler);

export default router;
