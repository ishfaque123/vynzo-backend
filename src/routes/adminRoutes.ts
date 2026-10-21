import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware';
import { adminMiddleware } from '../middleware/adminMiddleware';
import {
  getAdminOverview,
  listAdminUsers,
  updateAdminUserStatus,
  updateAdminUserVerification,
  deleteAdminUser,
  clearAdminUserStrikes,
  setAdminUserMonetization,
  addAdminUserEarnings,
  listAdminPosts,
  deleteAdminPost,
  listAdminReports,
  listAdminComments,
  deleteAdminComment,
  deleteAdminReel,
  listAdminAuthFailures,
  listAdminVerificationRequests,
  deleteAdminReport,
  reviewAdminVerificationRequest,
  clearAllAdminMessages,
  getAdminSeoSettings,
  updateAdminSeoSettings,
  setAdminUserAvatar,
  adminUploadReel,
} from '../controllers/adminController';
import { upload } from '../middleware/upload';
import { getMediaCensusHandler } from '../controllers/mediaCensusController';
import { getDbCensusHandler, startDbOptimizeHandler, getDbOptimizeStatusHandler } from '../controllers/dbCensusController';
import { optimizeOneMediaHandler, optimizeBatchStartHandler, optimizeBatchStatusHandler } from '../controllers/mediaOptimizeController';
import { reelUpload } from '../middleware/reelUpload';

const router = Router();

router.use(authMiddleware, adminMiddleware);

router.get('/overview', getAdminOverview);
router.get('/media/census', getMediaCensusHandler);
router.get('/db/census', getDbCensusHandler);
router.post('/db/optimize', startDbOptimizeHandler);
router.get('/db/optimize/status', getDbOptimizeStatusHandler);
router.get('/media/optimize-one', optimizeOneMediaHandler);
router.get('/media/optimize-batch/start', optimizeBatchStartHandler);
router.get('/media/optimize-batch/status', optimizeBatchStatusHandler);
router.get('/users', listAdminUsers);
router.patch('/users/:userId/status', updateAdminUserStatus);
router.patch('/users/:userId/verification', updateAdminUserVerification);
router.delete('/users/:userId', deleteAdminUser);
router.delete('/users/:userId/strikes', clearAdminUserStrikes);
router.post('/users/:userId/monetization', setAdminUserMonetization);
router.post('/users/:userId/earnings', addAdminUserEarnings);
router.get('/posts', listAdminPosts);
router.delete('/posts/:postId', deleteAdminPost);
router.get('/reports', listAdminReports);
router.delete('/reports/:type/:reportId', deleteAdminReport);
router.get('/comments', listAdminComments);
router.delete('/comments/:commentId', deleteAdminComment);
router.delete('/reels/:reelId', deleteAdminReel);
router.get('/auth-failures', listAdminAuthFailures);
router.get('/verification-requests', listAdminVerificationRequests);
router.patch('/verification-requests/:requestId', reviewAdminVerificationRequest);
router.delete('/messages/clear-all', clearAllAdminMessages);
router.get('/seo-settings', getAdminSeoSettings);
router.put('/seo-settings', updateAdminSeoSettings);
router.post('/users/avatar', upload.single('image'), setAdminUserAvatar);
router.post('/reels/upload', reelUpload.single('video'), adminUploadReel);

export default router;
