import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware';
import {
  listConversationsHandler,
  createConversationHandler,
  getMessagesHandler,
  deleteConversationHandler,
  setDisappearingHandler,
  sendMessageHandler,
} from '../controllers/messageController';

const router = Router();
router.get('/conversations', authMiddleware, listConversationsHandler);
router.post('/conversations', authMiddleware, createConversationHandler);
router.delete('/conversations/:id', authMiddleware, deleteConversationHandler);
router.get('/conversations/:id/messages', authMiddleware, getMessagesHandler);
router.post('/conversations/:id/messages', authMiddleware, sendMessageHandler);
router.post('/conversations/:id/disappearing', authMiddleware, setDisappearingHandler);

export default router;
