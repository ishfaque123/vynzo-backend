import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware';
import {
  getPayoutMethodsHandler, addPayoutMethodHandler, deletePayoutMethodHandler,
  setDefaultPayoutMethodHandler, getEarningsHandler,
} from '../controllers/payoutController';

const router = Router();

router.get('/methods', authMiddleware, getPayoutMethodsHandler);
router.post('/methods', authMiddleware, addPayoutMethodHandler);
router.delete('/methods/:id', authMiddleware, deletePayoutMethodHandler);
router.post('/methods/:id/default', authMiddleware, setDefaultPayoutMethodHandler);
router.get('/earnings', authMiddleware, getEarningsHandler);

export default router;
