import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware';
import { reverseGeocodeHandler } from '../controllers/geoController';

const router = Router();
router.get('/reverse', authMiddleware, reverseGeocodeHandler);

export default router;
