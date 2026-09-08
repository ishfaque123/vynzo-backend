import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../utils/ApiResponse';
import { ApiError } from '../middleware/errorHandler';
import { getOrCreateConversation, listConversations, getMessages } from '../services/messageService';
import { isUserOnline } from '../socket/socketServer';

export async function listConversationsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const conversations = await listConversations(req.user!.id);
    const withPresence = conversations.map((c) => ({
      ...c,
      otherUser: c.otherUser ? { ...c.otherUser, isOnline: isUserOnline(c.otherUser.id) } : null,
    }));
    sendSuccess(res, withPresence);
  } catch (err) {
    next(err);
  }
}

export async function createConversationHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { userId } = req.body as { userId?: string };
    if (!userId) throw new ApiError(400, 'MISSING_USER_ID', 'userId is required.');
    const conversation = await getOrCreateConversation(req.user!.id, userId);
    sendSuccess(res, { id: conversation.id });
  } catch (err) {
    next(err);
  }
}

export async function getMessagesHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params;
    const cursor = req.query.cursor as string | undefined;
    const messages = await getMessages(req.user!.id, id, cursor);
    sendSuccess(res, messages);
  } catch (err) {
    next(err);
  }
}
