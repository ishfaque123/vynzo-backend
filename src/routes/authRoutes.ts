import { Router } from 'express';
import {
  googleLoginStart,
  googleCallback,
  googleNativeConfig,
  googleNativeLogin,
  requestEmailCode,
  verifyEmailCode,
  getMe,
  getAccounts,
  switchSavedAccount,
  logout,
  savePublicKeyHandler,
} from '../controllers/authController';
import { authMiddleware } from '../middleware/authMiddleware';
import { authLimiter } from '../middleware/rateLimiter';

const router = Router();
router.get('/google/start', googleLoginStart);
router.get('/google/callback', googleCallback);
router.get('/google/native-config', googleNativeConfig);
router.post('/google/native', authLimiter, googleNativeLogin);
router.post('/email/request-code', authLimiter, requestEmailCode);
router.post('/email/verify-code', authLimiter, verifyEmailCode);
router.get('/me', authMiddleware, getMe);
router.get('/accounts', getAccounts);
router.post('/switch', switchSavedAccount);
router.post('/logout', logout);
router.post('/public-key', authMiddleware, savePublicKeyHandler);

export default router;
