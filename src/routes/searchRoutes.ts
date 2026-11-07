import { Router } from 'express';
import { searchHandler } from '../controllers/searchController';
import { optionalAuth } from '../middleware/optionalAuth';

const router = Router();

// v5.18 (staged, NOT deployed): free-text search over public posts +
// reels. Public for logged-out visitors too, but attach like/follow
// state when a user is signed in (same as the tag route).
router.get('/', optionalAuth, searchHandler);

export default router;
