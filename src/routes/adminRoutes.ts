import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware';
import { adminMiddleware } from '../middleware/adminMiddleware';
import {
  getAdminOverview,
  listAdminUsers,
  updateAdminUserStatus,
  updateAdminUserVerification,
  listAdminPosts,
  deleteAdminPost,
  listAdminReports,
  listAdminComments,
  deleteAdminComment,
  deleteAdminReel,
  listAdminAuthFailures,
  listAdminVerificationRequests,
  reviewAdminVerificationRequest,
} from '../controllers/adminController';

const router = Router();

router.use(authMiddleware, adminMiddleware);

router.get('/overview', getAdminOverview);
router.get('/users', listAdminUsers);
router.patch('/users/:userId/status', updateAdminUserStatus);
router.patch('/users/:userId/verification', updateAdminUserVerification);
router.get('/posts', listAdminPosts);
router.delete('/posts/:postId', deleteAdminPost);
router.get('/reports', listAdminReports);
router.get('/comments', listAdminComments);
router.delete('/comments/:commentId', deleteAdminComment);
router.delete('/reels/:reelId', deleteAdminReel);
router.get('/auth-failures', listAdminAuthFailures);
router.get('/verification-requests', listAdminVerificationRequests);
router.patch('/verification-requests/:requestId', reviewAdminVerificationRequest);

export default router;
