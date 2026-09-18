import { Router } from 'express';
import { reportAuthFailure } from '../controllers/authFailureController';

const router = Router();
router.post('/', reportAuthFailure);

export default router;
