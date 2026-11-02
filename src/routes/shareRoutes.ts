import { Router } from 'express';
import { createShareLinkHandler, getShareLinkHandler, recordShareEventHandler } from '../controllers/shareController';
import { optionalAuth } from '../middleware/optionalAuth';

const router = Router();
router.post('/', createShareLinkHandler);
router.post('/event', optionalAuth, recordShareEventHandler);
router.get('/:code', getShareLinkHandler);

export default router;
