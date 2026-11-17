import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware';
import {
  getBoostConfigHandler, createBoostRequestHandler, getMyBoostsHandler,
} from '../controllers/boostController';

const router = Router();

router.get('/config', authMiddleware, getBoostConfigHandler);
router.get('/mine', authMiddleware, getMyBoostsHandler);
router.post('/', authMiddleware, createBoostRequestHandler);

export default router;
