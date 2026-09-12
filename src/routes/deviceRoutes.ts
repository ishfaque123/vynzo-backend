import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware';
import {
  getDevicesHandler,
  revokeDeviceHandler,
  revokeOtherDevicesHandler,
} from '../controllers/deviceController';

const router = Router();
router.get('/', authMiddleware, getDevicesHandler);
router.delete('/others', authMiddleware, revokeOtherDevicesHandler);
router.delete('/:id', authMiddleware, revokeDeviceHandler);

export default router;
