import { Router } from 'express';
import { authMiddleware } from '../middleware/authMiddleware';
import {
  listConversationsHandler,
  listMessageRequestsHandler,
  messageRequestCountHandler,
  acceptMessageRequestHandler,
  createConversationHandler,
  getMessagesHandler,
  deleteConversationHandler,
  setDisappearingHandler,
  sendMessageHandler,
} from '../controllers/messageController';

const router = Router();
router.get('/conversations', authMiddleware, listConversationsHandler);
router.get('/requests', authMiddleware, listMessageRequestsHandler);
router.get('/requests/count', authMiddleware, messageRequestCountHandler);
router.post('/conversations', authMiddleware, createConversationHandler);
router.post('/conversations/:id/accept-request', authMiddleware, acceptMessageRequestHandler);
router.delete('/conversations/:id', authMiddleware, deleteConversationHandler);
router.get('/conversations/:id/messages', authMiddleware, getMessagesHandler);
router.post('/conversations/:id/messages', authMiddleware, sendMessageHandler);
router.post('/conversations/:id/disappearing', authMiddleware, setDisappearingHandler);

export default router;
