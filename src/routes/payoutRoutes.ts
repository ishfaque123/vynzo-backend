import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware';
import {
  getPayoutMethodsHandler, addPayoutMethodHandler, deletePayoutMethodHandler,
  setDefaultPayoutMethodHandler, getEarningsHandler,
  getReferralsListHandler, getEarningsByContentHandler, getPayoutHistoryHandler,
} from '../controllers/payoutController';

const router = Router();

router.get('/methods', authMiddleware, getPayoutMethodsHandler);
router.post('/methods', authMiddleware, addPayoutMethodHandler);
router.delete('/methods/:id', authMiddleware, deletePayoutMethodHandler);
router.post('/methods/:id/default', authMiddleware, setDefaultPayoutMethodHandler);
router.get('/earnings', authMiddleware, getEarningsHandler);
router.get('/earnings/by-content', authMiddleware, getEarningsByContentHandler);
router.get('/referrals', authMiddleware, getReferralsListHandler);
router.get('/history', authMiddleware, getPayoutHistoryHandler);

export default router;
