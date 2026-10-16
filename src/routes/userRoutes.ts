import { Router } from 'express';
import { getMyProfile, getPublicProfile, postProfileSetup, patchMyProfile, searchUsersHandler, getMyDashboard, getMyReferral, claimMyReferral, getReferralLeaderboardHandler, deleteMyAccount, reportUserHandler, updateAvatarHandler, updateCoverHandler, createVerificationRequest, getMyVerificationRequest, getMyAchievements, getUserAchievementsHandler,
  getMyStrikes,
  getInterests,
  updateMyInterests,
  markNotInterested} from '../controllers/userController';
import { upload } from '../middleware/upload';
import { authMiddleware } from '../middleware/authMiddleware';
import { optionalAuth } from '../middleware/optionalAuth';

const router = Router();
router.get('/me', authMiddleware, getMyProfile);
router.patch('/me', authMiddleware, patchMyProfile);
router.delete('/me', authMiddleware, deleteMyAccount);
router.post('/me/profile-setup', authMiddleware, postProfileSetup);
router.get('/me/dashboard', authMiddleware, getMyDashboard);
router.get('/me/referral', authMiddleware, getMyReferral);
router.post('/me/referral/claim', authMiddleware, claimMyReferral);
router.get('/leaderboard', getReferralLeaderboardHandler);
router.get('/me/verification-request', authMiddleware, getMyVerificationRequest);
router.post('/me/verification-request', authMiddleware, createVerificationRequest);
router.get('/me/achievements', authMiddleware, getMyAchievements);
router.get('/me/strikes', authMiddleware, getMyStrikes);
router.get('/interests', getInterests);
router.put('/me/interests', authMiddleware, updateMyInterests);
router.post('/me/not-interested', authMiddleware, markNotInterested);
router.get('/:username/achievements', optionalAuth, getUserAchievementsHandler);
router.get('/search', optionalAuth, searchUsersHandler);
router.post('/:userId/report', authMiddleware, reportUserHandler);
router.post('/me/avatar', authMiddleware, upload.single('image'), updateAvatarHandler);
router.post('/me/cover', authMiddleware, upload.single('image'), updateCoverHandler);
router.get('/:username', optionalAuth, getPublicProfile);

export default router;
