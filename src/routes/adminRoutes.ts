import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware';
import { adminMiddleware } from '../middleware/adminMiddleware';
import {
  getAdminOverview,
  listAdminUsers,
  updateAdminUserStatus,
  listAdminPosts,
  deleteAdminPost,
  listAdminReports,
  deleteAdminComment,
  deleteAdminReel,
  listAdminAuthFailures,
} from '../controllers/adminController';

const router = Router();

router.use(authMiddleware, adminMiddleware);

router.get('/overview', getAdminOverview);
router.get('/users', listAdminUsers);
router.patch('/users/:userId/status', updateAdminUserStatus);
router.get('/posts', listAdminPosts);
router.delete('/posts/:postId', deleteAdminPost);
router.get('/reports', listAdminReports);
router.delete('/comments/:commentId', deleteAdminComment);
router.delete('/reels/:reelId', deleteAdminReel);
router.get('/auth-failures', listAdminAuthFailures);

export default router;
