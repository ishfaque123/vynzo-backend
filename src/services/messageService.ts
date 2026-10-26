import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';
import { isEitherBlocked } from './blockService';
import { ensureRestrictColumn, moderateChatMessage } from './moderationService';

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

// ---------------------------------------------------------------------------
// REST send path (notification quick reply). The chat UI sends via Socket.IO;
// this mirrors the socket message:send guards for TEXT-ONLY sends so a
// notification reply cannot bypass what the socket path blocks. Live emit +
// push to the other participant happen in the controller (it already owns
// the socket imports), keeping this service socket-free.
// ---------------------------------------------------------------------------

// Simple per-user rate limiter for the REST send path (mirrors the socket
// limiter: 20 sends per 10s). Quick replies need a user tap each, but the
// endpoint is also directly callable with a session cookie.
const restRateLimits = new Map<string, number[]>();
function checkRestRateLimit(userId: string, max = 20, windowMs = 10000): boolean {
  const now = Date.now();
  let times = restRateLimits.get(userId);
  if (!times) {
    times = [];
    restRateLimits.set(userId, times);
  }
  while (times.length && now - times[0] > windowMs) times.shift();
  if (times.length >= max) return false;
  times.push(now);
  return true;
}

export async function sendTextMessage(userId: string, conversationId: string, content: string) {
  if (!checkRestRateLimit(userId)) {
    throw new ApiError(429, 'RATE_LIMITED', 'Too many messages. Please wait a moment.');
  }
  await ensureRestrictColumn();
  const meRow = await prisma.user.findUnique({
    where: { id: userId },
    select: { messageRestrictedUntil: true, accountStatus: true },
  });
  if (meRow?.accountStatus !== 'active') {
    throw new ApiError(403, 'ACCOUNT_SUSPENDED', 'Your account is suspended.');
  }
  if (meRow?.messageRestrictedUntil && meRow.messageRestrictedUntil > new Date()) {
    throw new ApiError(403, 'MESSAGING_RESTRICTED', 'Messaging is temporarily restricted.');
  }
  const trimmed = (content || '').trim();
  if (!trimmed) {
    throw new ApiError(400, 'EMPTY_MESSAGE', 'Message is empty.');
  }
  if (!conversationId) {
    throw new ApiError(400, 'MISSING_CONVERSATION', 'Conversation is required.');
  }

  // Link-spam protection (same rule as the socket path): repeated external
  // links in 10 minutes temporarily restrict messaging.
  const URL_RE = /https?:\/\/[^\s]+|www\.[^\s]+/gi;
  const OWN_DOMAINS = ['frianzo.online', 'www.frianzo.online'];
  const OWN_APP_LINK = 'play.google.com/store/apps/details?id=com.frianzo.app';
  const isOwnLink = (url: string) => {
    const lower = url.toLowerCase();
    return OWN_DOMAINS.some((d) => lower.includes(d)) || lower.includes(OWN_APP_LINK);
  };
  const externalLinksIn = (text: string) => {
    const all = (text || '').match(URL_RE) || [];
    return all.filter((l) => !isOwnLink(l));
  };
  if (externalLinksIn(trimmed).length > 0) {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
    const recent = await prisma.message.findMany({
      where: { senderId: userId, createdAt: { gte: tenMinAgo } },
      select: { content: true },
      take: 50,
      orderBy: { createdAt: 'desc' },
    });
    let linkCount = 0;
    const seenLinks = new Map<string, number>();
    for (const m of recent) {
      const links = externalLinksIn(m.content || '');
      for (const l of links) {
        linkCount++;
        const key = l.toLowerCase().replace(/\/$/, '');
        seenLinks.set(key, (seenLinks.get(key) || 0) + 1);
      }
    }
    const sameLinkMax = Math.max(0, ...seenLinks.values());
    if (linkCount >= 4 || sameLinkMax >= 2) {
      const until = new Date(Date.now() + 60 * 60 * 1000);
      await prisma.user.update({ where: { id: userId }, data: { messageRestrictedUntil: until } });
      throw new ApiError(403, 'LINK_SPAM_RESTRICTED', 'Messaging is temporarily restricted due to link sharing.');
    }
  }

  const isParticipantRow = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
  });
  if (!isParticipantRow) {
    throw new ApiError(403, 'NOT_A_PARTICIPANT', 'You are not a participant of this conversation.');
  }

  const otherParticipant = await prisma.conversationParticipant.findFirst({
    where: { conversationId, userId: { not: userId } },
  });
  if (otherParticipant) {
    const blocked = await isEitherBlocked(userId, otherParticipant.userId);
    if (blocked) {
      throw new ApiError(403, 'BLOCKED', 'Messaging is not available with this user.');
    }
    const target = await prisma.user.findUnique({
      where: { id: otherParticipant.userId },
      select: { messagePermission: true },
    });
    if (target?.messagePermission === 'none') {
      throw new ApiError(403, 'MESSAGES_DISABLED', 'This user does not accept messages.');
    }
    if (target?.messagePermission === 'followers') {
      const isFollower = await prisma.follow.findUnique({
        where: { followerId_followingId: { followerId: userId, followingId: otherParticipant.userId } },
      });
      if (!isFollower) {
        throw new ApiError(403, 'MESSAGES_RESTRICTED', 'Only followers can message this user.');
      }
    }
  }

  // Disappearing messages: if the conversation has a timer, set expiry.
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { disappearingDuration: true },
  });
  const expiresAt = conv?.disappearingDuration
    ? new Date(Date.now() + conv.disappearingDuration * 1000)
    : null;

  const message = await prisma.message.create({
    data: {
      conversationId,
      senderId: userId,
      content: trimmed,
      mediaUrl: null,
      mediaType: null,
      voiceDuration: null,
      replyToId: null,
      isForwarded: false,
      expiresAt,
    },
    include: {
      sender: { select: { id: true, username: true, displayName: true, profilePictureUrl: true } },
      replyTo: { include: { sender: { select: { id: true, username: true, displayName: true, profilePictureUrl: true } } } },
      reactions: { select: { userId: true, emoji: true } },
    },
  });

  // Background abuse check on text content (delayed action handled inside).
  if (message.content?.trim()) {
    setImmediate(() => { moderateChatMessage(message.id).catch((err) => console.error('[moderation] background chat check failed', err)); });
  }

  await prisma.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
  return { message, otherParticipant };
}
