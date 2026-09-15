import { Router } from 'express';
import {
  googleLoginStart,
  googleCallback,
  googleNativeConfig,
  googleNativeLogin,
  getMe,
  getAccounts,
  switchSavedAccount,
  logout,
  savePublicKeyHandler,
} from '../controllers/authController';
import { authMiddleware } from '../middleware/authMiddleware';

const router = Router();
router.get('/google/start', googleLoginStart);
router.get('/google/callback', googleCallback);
router.get('/google/native-config', googleNativeConfig);
router.post('/google/native', googleNativeLogin);
router.get('/me', authMiddleware, getMe);
router.get('/accounts', getAccounts);
router.post('/switch', switchSavedAccount);
router.post('/logout', logout);
router.post('/public-key', authMiddleware, savePublicKeyHandler);

export default router;
