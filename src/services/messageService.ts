import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';
import { isEitherBlocked } from './blockService';

const userSelect = { id: true, username: true, displayName: true, profilePictureUrl: true, lastActiveAt: true, publicKey: true, showOnlineStatus: true } as const;

export async function getOrCreateConversation(userId: string, otherUserId: string) {
  if (userId === otherUserId) {
    throw new ApiError(400, 'INVALID_TARGET', 'Cannot start a conversation with yourself.');
  }

  const otherUser = await prisma.user.findUnique({ where: { id: otherUserId } });
  if (!otherUser) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found.');

  const blocked = await isEitherBlocked(userId, otherUserId);
  if (blocked) throw new ApiError(403, 'BLOCKED', 'You cannot message this user.');

  if (otherUser.messagePermission === 'none') {
    throw new ApiError(403, 'MESSAGES_DISABLED', 'This user is not accepting messages.');
  }
  if (otherUser.messagePermission === 'followers') {
    const isFollower = await prisma.follow.findUnique({
      where: { followerId_followingId: { followerId: userId, followingId: otherUserId } },
    });
    if (!isFollower) throw new ApiError(403, 'MESSAGES_RESTRICTED', 'This user only accepts messages from people they follow.');
  }

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

    let lastMessageStatus: 'sent' | 'delivered' | 'read' | null = null;
    if (lastMessage && lastMessage.senderId === userId) {
      if (other?.lastReadAt && other.lastReadAt >= lastMessage.createdAt) lastMessageStatus = 'read';
      else if (other?.lastDeliveredAt && other.lastDeliveredAt >= lastMessage.createdAt) lastMessageStatus = 'delivered';
      else lastMessageStatus = 'sent';
    }

    const otherUserShaped = other?.user
      ? { ...other.user, lastActiveAt: other.user.showOnlineStatus === false ? null : other.user.lastActiveAt }
      : null;

    return {
      id: c.id,
      isGroup: c.isGroup,
      otherUser: otherUserShaped,
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
    where: { conversationId, hiddenFor: { none: { userId } } },
    orderBy: { createdAt: 'desc' },
    take: limit,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: { sender: { select: userSelect } },
  });

  const shaped = messages.reverse().map((m) =>
    m.deletedAt
      ? { ...m, content: '', mediaUrl: null, mediaType: null, voiceDuration: null, isDeleted: true }
      : { ...m, isDeleted: false }
  );

  return {
    messages: shaped,
    otherLastReadAt: other?.lastReadAt || null,
    otherLastDeliveredAt: other?.lastDeliveredAt || null,
  };
}

export async function deleteMessageForMe(userId: string, messageId: string) {
  const message = await prisma.message.findUnique({ where: { id: messageId } });
  if (!message) throw new ApiError(404, 'MESSAGE_NOT_FOUND', 'Message not found.');

  const participant = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId: message.conversationId, userId } },
  });
  if (!participant) throw new ApiError(403, 'NOT_A_PARTICIPANT', 'You are not part of this conversation.');

  await prisma.hiddenMessage.upsert({
    where: { userId_messageId: { userId, messageId } },
    update: {},
    create: { userId, messageId },
  });

  return { deleted: true };
}

export async function deleteMessageForEveryone(userId: string, messageId: string) {
  const message = await prisma.message.findUnique({ where: { id: messageId } });
  if (!message) throw new ApiError(404, 'MESSAGE_NOT_FOUND', 'Message not found.');
  if (message.senderId !== userId) {
    throw new ApiError(403, 'FORBIDDEN', 'You can only delete your own messages for everyone.');
  }

  await prisma.message.update({ where: { id: messageId }, data: { deletedAt: new Date() } });

  return { conversationId: message.conversationId };
}
