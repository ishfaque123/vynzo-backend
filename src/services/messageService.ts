import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';

const userSelect = { id: true, username: true, displayName: true, profilePictureUrl: true } as const;

export async function getOrCreateConversation(userId: string, otherUserId: string) {
  if (userId === otherUserId) {
    throw new ApiError(400, 'INVALID_TARGET', 'Cannot start a conversation with yourself.');
  }

  const otherUser = await prisma.user.findUnique({ where: { id: otherUserId } });
  if (!otherUser) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found.');

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

    return {
      id: c.id,
      isGroup: c.isGroup,
      otherUser: other?.user || null,
      lastMessage,
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

  const messages = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: { sender: { select: userSelect } },
  });

  return messages.reverse();
}
