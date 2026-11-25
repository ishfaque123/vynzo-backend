import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware';
import {
  getBoostConfigHandler, createBoostRequestHandler, getMyBoostsHandler, recordBoostLinkClickHandler,
} from '../controllers/boostController';

const router = Router();

router.get('/config', authMiddleware, getBoostConfigHandler);
router.get('/mine', authMiddleware, getMyBoostsHandler);
router.post('/', authMiddleware, createBoostRequestHandler);
router.post('/:id/click', authMiddleware, recordBoostLinkClickHandler);

export default router;
