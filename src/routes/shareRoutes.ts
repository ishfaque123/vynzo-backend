import { Router } from 'express';
import { createShareLinkHandler, getShareLinkHandler } from '../controllers/shareController';

const router = Router();
router.post('/', createShareLinkHandler);
router.get('/:code', getShareLinkHandler);

export default router;
