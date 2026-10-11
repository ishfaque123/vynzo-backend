import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware';
import { statusUpload } from '../middleware/statusUpload';
import { createStatusHandler, getStatusFeedHandler, viewStatusHandler, getStatusViewersHandler, deleteStatusHandler, toggleStatusLikeHandler, votePollHandler, answerQuestionHandler, muteStoriesHandler, unmuteStoriesHandler, getMutedStoriesHandler } from '../controllers/statusController';

const router = Router();
router.get('/', authMiddleware, getStatusFeedHandler);
router.post('/', authMiddleware, statusUpload.single('media'), createStatusHandler);
router.post('/:id/view', authMiddleware, viewStatusHandler);
router.post('/:id/like', authMiddleware, toggleStatusLikeHandler);
router.get('/:id/viewers', authMiddleware, getStatusViewersHandler);
router.delete('/:id', authMiddleware, deleteStatusHandler);
// Stickers
router.post('/stickers/:stickerId/vote', authMiddleware, votePollHandler);
router.post('/stickers/:stickerId/answer', authMiddleware, answerQuestionHandler);
// Story mute
router.get('/muted', authMiddleware, getMutedStoriesHandler);
router.post('/mute/:userId', authMiddleware, muteStoriesHandler);
router.delete('/mute/:userId', authMiddleware, unmuteStoriesHandler);

export default router;
