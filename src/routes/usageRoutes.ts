import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware';
import { pingHandler, getPingsHandler } from '../controllers/usageController';

const router = Router();
router.post('/ping', authMiddleware, pingHandler);
router.get('/', authMiddleware, getPingsHandler);

export default router;
