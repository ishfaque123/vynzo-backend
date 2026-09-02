import { Router } from 'express';
import { googleLogin, getMe, logout } from '../controllers/authController';
import { authMiddleware } from '../middleware/authMiddleware';

const router = Router();
router.post('/google', googleLogin);
router.get('/me', authMiddleware, getMe);
router.post('/logout', logout);

export default router;
