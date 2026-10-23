import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';
import { isEitherBlocked } from './blockService';

const userSelect = { id: true, username: true, displayName: true, profilePictureUrl: true, lastActiveAt: true, publicKey: true, showOnlineStatus: true, isVerified: true } as const;

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
      // Owner decision (2026-10-23): disappearing messages are ON by
      // default at 1 hour for every conversation. Either participant can
      // still change the duration or turn it off per chat.
      disappearingDuration: 3600,
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
      // Never surface a message the user deleted for themselves, and never
      // let a "deleted for everyone" message leak its original content into
      // the inbox preview.
      messages: { where: { hiddenFor: { none: { userId } } }, orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });

  const unreadCounts = await Promise.all(
    conversations.map((c) => {
      const me = c.participants.find((p) => p.userId === userId);
      return prisma.message.count({
        where: {
          conversationId: c.id,
          senderId: { not: userId },
          hiddenFor: { none: { userId } },
          ...(me?.lastReadAt ? { createdAt: { gt: me.lastReadAt } } : {}),
        },
      });
    })
  );

  return conversations.map((c, i) => {
    const me = c.participants.find((p) => p.userId === userId);
    const other = c.participants.find((p) => p.userId !== userId);
    const rawLastMessage = c.messages[0] || null;
    const lastMessage = rawLastMessage
      ? rawLastMessage.deletedAt
        ? { ...rawLastMessage, content: '', mediaUrl: null, mediaType: null, isDeleted: true }
        : { ...rawLastMessage, isDeleted: false }
      : null;
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
      disappearingDuration: c.disappearingDuration ?? null,
      otherUser: otherUserShaped,
      lastMessage,
      lastMessageStatus,
      unread,
      unreadCount: unreadCounts[i],
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

  const now = new Date();
  const messages = await prisma.message.findMany({
    where: {
      conversationId,
      hiddenFor: { none: { userId } },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: {
      sender: { select: userSelect },
      replyTo: { include: { sender: { select: userSelect } } },
      reactions: { select: { userId: true, emoji: true } },
    },
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

export async function deleteConversation(userId: string, conversationId: string) {
  const participant = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
  });
  if (!participant) throw new ApiError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found.');

  await prisma.$transaction(async (tx) => {
    const messages = await tx.message.findMany({ where: { conversationId }, select: { id: true } });
    if (messages.length) {
      await tx.hiddenMessage.deleteMany({ where: { userId, messageId: { in: messages.map((m) => m.id) } } });
    }
    await tx.conversationParticipant.delete({ where: { conversationId_userId: { conversationId, userId } } });
  });

  return { deleted: true };
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

/** Set disappearing-message timer for a conversation (null = off). */
export async function setDisappearingDuration(userId: string, conversationId: string, duration: number | null) {
  const participant = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
  });
  if (!participant) throw new ApiError(403, 'NOT_A_PARTICIPANT', 'You are not part of this conversation.');

  const updated = await prisma.conversation.update({
    where: { id: conversationId },
    data: { disappearingDuration: duration },
    select: { id: true, disappearingDuration: true },
  });
  return updated;
}

const DISAPPEARING_DEFAULT_MIGRATION_KEY = 'disappearing_default_1h_v1';

/**
 * One-time migration (owner decision 2026-10-23): every existing
 * conversation that never had a disappearing timer set (NULL) gets the new
 * 1-hour default. Conversations with an explicitly chosen duration
 * (24h / 7d / 90d) are untouched. Message rows are never modified — existing
 * messages keep expiresAt = null, so all history survives; only messages
 * sent after the flip get the 1-hour expiry stamp at send time.
 *
 * Runs exactly once, guarded by a persistent marker row in `app_migrations`:
 * the claim is an INSERT IGNORE on the marker's primary key, and only the
 * boot that actually inserts the row runs the UPDATE. The marker is claimed
 * BEFORE the UPDATE on purpose — turning a chat OFF also writes NULL, so any
 * scheme that could re-run the UPDATE on a later boot would wrongly re-flip
 * chats users deliberately turned off. With claim-first ordering the flip can
 * never run twice; the only failure window is a crash between claim and
 * UPDATE skipping the flip entirely (recover by deleting the marker row and
 * restarting — the failure is logged below if the UPDATE itself errors).
 * Safe under concurrent boots: CREATE TABLE IF NOT EXISTS is idempotent and
 * the duplicate-key claim lets exactly one boot through.
 */
export async function ensureDisappearingDefaultMigration() {
  try {
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS \`app_migrations\` (
      \`migration_key\` VARCHAR(100) NOT NULL PRIMARY KEY,
      \`applied_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    )`);

    const claimed = await prisma.$executeRawUnsafe(
      'INSERT IGNORE INTO `app_migrations` (`migration_key`) VALUES (?)',
      DISAPPEARING_DEFAULT_MIGRATION_KEY
    );
    if (claimed === 0) {
      console.log('[disappearing] default-1h migration already applied, skipping');
      return;
    }

    const result = await prisma.conversation.updateMany({
      where: { disappearingDuration: null },
      data: { disappearingDuration: 3600 },
    });
    console.log(
      `[disappearing] default-1h migration applied: set disappearing_duration=3600 on ${result.count} existing conversation(s)`
    );
  } catch (e) {
    console.error('[disappearing] default-1h migration failed', e);
  }
}
