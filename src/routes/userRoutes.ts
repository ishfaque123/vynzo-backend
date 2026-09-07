import { Router } from 'express';
import { getMyProfile, getPublicProfile, postProfileSetup, patchMyProfile, searchUsersHandler, getMyDashboard } from '../controllers/userController';
import { authMiddleware } from '../middleware/authMiddleware';
import { optionalAuth } from '../middleware/optionalAuth';

const router = Router();
router.get('/me', authMiddleware, getMyProfile);
router.patch('/me', authMiddleware, patchMyProfile);
router.post('/me/profile-setup', authMiddleware, postProfileSetup);
router.get('/me/dashboard', authMiddleware, getMyDashboard);
router.get('/search', searchUsersHandler);
router.get('/:username', optionalAuth, getPublicProfile);

export default router;
