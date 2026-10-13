import { Router } from 'express';
import { getTagHandler } from '../controllers/tagController';
import { optionalAuth } from '../middleware/optionalAuth';

const router = Router();

// Public tag pages work for logged-out visitors too, but attach
// like/follow state when a user is signed in.
router.get('/:tag', optionalAuth, getTagHandler);

export default router;
