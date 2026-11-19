import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware';
import { createBlueTickPaymentHandler } from '../controllers/payfastController';

const router = Router();

// Authenticated user routes (mounted in app.ts with the other API
// routers, after the origin check).
router.post('/blue-tick/create', authMiddleware, createBlueTickPaymentHandler);

export default router;
