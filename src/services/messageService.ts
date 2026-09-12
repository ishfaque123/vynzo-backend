import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';
import { isEitherBlocked } from './blockService';

const userSelect = { id: true, username: true, displayName: true, profilePictureUrl: true, lastActiveAt: true } as const;

export async function getOrCreateConversation(userId: string, otherUserId: string) {
  if (userId === otherUserId) {
    throw new ApiError(400, 'INVALID_TARGET', 'Cannot start a conversation with yourself.');
  }

  const otherUser = await prisma.user.findUnique({ where: { id: otherUserId } });
  if (!otherUser) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found.');

  const blocked = await isEitherBlocked(userId, otherUserId);
  if (blocked) throw new ApiError(403, 'BLOCKED', 'You cannot message this user.');

  const existing = await prisma.conversation.findFirst({
    where: {
      isGroup: false,
      AND: [
        { participants: { some: { userId } } },
        { participants: { some: { userId: otherUserId } } },
      ],
    },
    include: { participants: true },
  });

  if (existing && existing.participants.length === 2) return existing;

  return prisma.conversation.create({
    data: {
      isGroup: false,
      participants: { create: [{ userId }, { userId: otherUserId }] },
    },
    include: { participants: true },
  });
}

export async function listConversations(userId: string) {
  const conversations = await prisma.conversation.findMany({
    where: { participants: { some: { userId } } },
    orderBy: { updatedAt: 'desc' },
    include: {
      participants: { include: { user: { select: userSelect } } },
      messages: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });

  return conversations.map((c) => {
    const me = c.participants.find((p) => p.userId === userId);
    const other = c.participants.find((p) => p.userId !== userId);
    const lastMessage = c.messages[0] || null;
    const unread = lastMessage
      ? lastMessage.senderId !== userId && (!me?.lastReadAt || lastMessage.createdAt > me.lastReadAt)
      : false;

    // If the last message is one I sent, tell the list view whether the
    // other person has seen it / received it yet — powers the tick shown
    // next to the preview text (WhatsApp-style).
    let lastMessageStatus: 'sent' | 'delivered' | 'read' | null = null;
    if (lastMessage && lastMessage.senderId === userId) {
      if (other?.lastReadAt && other.lastReadAt >= lastMessage.createdAt) lastMessageStatus = 'read';
      else if (other?.lastDeliveredAt && other.lastDeliveredAt >= lastMessage.createdAt) lastMessageStatus = 'delivered';
      else lastMessageStatus = 'sent';
    }

    return {
      id: c.id,
      isGroup: c.isGroup,
      otherUser: other?.user || null,
      lastMessage,
      lastMessageStatus,
      unread,
      updatedAt: c.updatedAt,
    };
  });
}

export async function getMessages(userId: string, conversationId: string, cursor?: string, limit = 30) {
  const participant = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
  });
  if (!participant) throw new ApiError(403, 'NOT_A_PARTICIPANT', 'You are not part of this conversation.');

  const other = await prisma.conversationParticipant.findFirst({
    where: { conversationId, userId: { not: userId } },
  });

  const messages = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: { sender: { select: userSelect } },
  });

  return {
    messages: messages.reverse(),
    otherLastReadAt: other?.lastReadAt || null,
    otherLastDeliveredAt: other?.lastDeliveredAt || null,
  };
}
