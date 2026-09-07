import { Router } from 'express';
import {
  googleLogin,
  getMe,
  getAccounts,
  switchSavedAccount,
  logout,
} from '../controllers/authController';
import { authMiddleware } from '../middleware/authMiddleware';

const router = Router();

router.post('/google', googleLogin);
router.get('/accounts', getAccounts);
router.post('/switch', switchSavedAccount);

router.get('/me', authMiddleware, getMe);
router.post('/logout', logout);

export default router;
