import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../utils/ApiResponse';
import { ApiError } from '../middleware/errorHandler';
import { prisma } from '../config/prisma';
import { getOrCreateConversation, listConversations, getMessages, deleteConversation, setDisappearingDuration, sendTextMessage } from '../services/messageService';
import { isUserOnline, emitToConversation, pushNewMessage } from '../socket/socketServer';

export async function listConversationsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const conversations = await listConversations(req.user!.id);
    const withPresence = conversations.map((c) => ({
      ...c,
      otherUser: c.otherUser
        ? { ...c.otherUser, isOnline: c.otherUser.showOnlineStatus === false ? false : isUserOnline(c.otherUser.id) }
        : null,
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

export async function deleteConversationHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params;
    const result = await deleteConversation(req.user!.id, id);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

export async function sendMessageHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params;
    const { content } = req.body as { content?: string };
    const { message, otherParticipant } = await sendTextMessage(req.user!.id, id, content ?? '');
    if (otherParticipant) {
      // Same delivery tail as the socket path: live emit + push.
      if (isUserOnline(otherParticipant.userId)) {
        await prisma.conversationParticipant.update({ where: { id: otherParticipant.id }, data: { lastDeliveredAt: new Date() } });
      }
      emitToConversation(id, 'message:new', message);
      pushNewMessage(message, otherParticipant, req.user!.id).catch((err) => console.error('[push] chat push failed', err));
    }
    sendSuccess(res, message);
  } catch (err) {
    next(err);
  }
}

const ALLOWED_DURATIONS = [3600, 86400, 604800, 7776000]; // 1h, 24h, 7d, 90d

export async function setDisappearingHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params;
    const { duration } = req.body as { duration?: number | null };
    if (duration !== null && duration !== undefined && !ALLOWED_DURATIONS.includes(duration)) {
      throw new ApiError(400, 'INVALID_DURATION', 'Invalid disappearing duration.');
    }
    const result = await setDisappearingDuration(req.user!.id, id, duration ?? null);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}
