import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware';
import { adminMiddleware } from '../middleware/adminMiddleware';
import {
  applyMonetizationHandler,
  getMyMonetizationHandler,
  listMonetizationHandler,
  reviewMonetizationHandler,
} from '../controllers/monetizationController';

const router = Router();

router.post('/apply', authMiddleware, applyMonetizationHandler);
router.get('/me', authMiddleware, getMyMonetizationHandler);
router.get('/requests', authMiddleware, adminMiddleware, listMonetizationHandler);
router.patch('/requests/:requestId', authMiddleware, adminMiddleware, reviewMonetizationHandler);

export default router;
