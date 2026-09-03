import { Router } from 'express';
import { getMyProfile, getPublicProfile, postProfileSetup, patchMyProfile, searchUsersHandler } from '../controllers/userController';
import { authMiddleware } from '../middleware/authMiddleware';

const router = Router();
router.get('/me', authMiddleware, getMyProfile);
router.patch('/me', authMiddleware, patchMyProfile);
router.post('/me/profile-setup', authMiddleware, postProfileSetup);
router.get('/search', searchUsersHandler);
router.get('/:username', getPublicProfile);

export default router;
