import { Router } from 'express';
import { getMyProfile, getPublicProfile, postProfileSetup, patchMyProfile, searchUsersHandler, getMyDashboard, deleteMyAccount, reportUserHandler } from '../controllers/userController';
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
router.get('/:username', optionalAuth, getPublicProfile);

export default router;
