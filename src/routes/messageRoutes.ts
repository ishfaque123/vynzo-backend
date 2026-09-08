import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware';
import {
  listConversationsHandler,
  createConversationHandler,
  getMessagesHandler,
} from '../controllers/messageController';

const router = Router();
router.get('/conversations', authMiddleware, listConversationsHandler);
router.post('/conversations', authMiddleware, createConversationHandler);
router.get('/conversations/:id/messages', authMiddleware, getMessagesHandler);

export default router;
