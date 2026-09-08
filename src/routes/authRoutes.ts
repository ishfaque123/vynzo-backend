import { Router } from 'express';
import {
  googleLoginStart,
  googleCallback,
  getMe,
  logout,
  listAccounts,
  switchAccount,
  removeAccount,
} from '../controllers/authController';
import { authMiddleware } from '../middleware/authMiddleware';

const router = Router();
router.get('/google/start', googleLoginStart);
router.get('/google/callback', googleCallback);
router.get('/me', authMiddleware, getMe);
router.get('/accounts', listAccounts);
router.post('/switch', switchAccount);
router.post('/accounts/remove', removeAccount);
router.post('/logout', logout);

export default router;
