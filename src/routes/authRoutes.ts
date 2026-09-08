import { Router } from 'express';
import {
  googleLoginStart,
  googleCallback,
  getMe,
  getAccounts,
  switchSavedAccount,
  logout,
} from '../controllers/authController';
import { authMiddleware } from '../middleware/authMiddleware';

const router = Router();
router.get('/google/start', googleLoginStart);
router.get('/google/callback', googleCallback);
router.get('/me', authMiddleware, getMe);
router.get('/accounts', getAccounts);
router.post('/switch', switchSavedAccount);
router.post('/logout', logout);

export default router;
