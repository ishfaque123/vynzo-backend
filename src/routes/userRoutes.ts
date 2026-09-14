import { Router } from 'express';
import { getMyProfile, getPublicProfile, postProfileSetup, patchMyProfile, searchUsersHandler, getMyDashboard, deleteMyAccount, reportUserHandler, updateAvatarHandler, updateCoverHandler } from '../controllers/userController';
import { upload } from '../middleware/upload';
import { authMiddleware } from '../middleware/authMiddleware';
import { optionalAuth } from '../middleware/optionalAuth';

const router = Router();
router.get('/me', authMiddleware, getMyProfile);
router.patch('/me', authMiddleware, patchMyProfile);
router.delete('/me', authMiddleware, deleteMyAccount);
router.post('/me/profile-setup', authMiddleware, postProfileSetup);
router.get('/me/dashboard', authMiddleware, getMyDashboard);
router.get('/search', searchUsersHandler);
router.post('/:userId/report', authMiddleware, reportUserHandler);
router.post('/me/avatar', authMiddleware, upload.single('image'), updateAvatarHandler);
router.post('/me/cover', authMiddleware, upload.single('image'), updateCoverHandler);
router.get('/:username', optionalAuth, getPublicProfile);

export default router;
