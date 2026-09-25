import { Server as IOServer, Socket } from 'socket.io';
import { Server as HttpServer } from 'http';
import { verifyToken } from '../utils/jwt';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { isEitherBlocked } from '../services/blockService';
import { deleteMessageForMe, deleteMessageForEveryone } from '../services/messageService';
import { sendPushToUser } from '../services/pushService';

interface AuthedSocket extends Socket {
  userId?: string;
  accountSessionId?: string;
}

// Phone push for a new chat message. Never includes the message text
// (chats are end-to-end encrypted): only who sent it and what kind it is.
async function pushNewMessage(
  message: { conversationId: string; mediaType: string | null; sender?: { displayName?: string | null; username?: string | null } | null },
  recipient: { userId: string; lastReadAt: Date | null },
  senderId: string
) {
  const unread = await prisma.message.count({
    where: { conversationId: message.conversationId, senderId, createdAt: { gt: recipient.lastReadAt ?? new Date(0) } },
  });
  const senderName = message.sender?.displayName || message.sender?.username || 'Someone';
  let body = 'New message';
  if (unread > 1) body = `${unread} new messages`;
  else if (message.mediaType === 'image') body = 'Sent you a photo';
  else if (message.mediaType === 'voice') body = 'Sent you a voice message';
  await sendPushToUser(recipient.userId, {
    title: senderName,
    body,
    url: `/messages/${message.conversationId}`,
    tag: `chat:${message.conversationId}`,
  });
}

const onlineUsers = new Map<string, Set<string>>();

export function isUserOnline(userId: string): boolean {
  return onlineUsers.has(userId);
}

function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  const match = header
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : undefined;
}

async function isParticipant(conversationId: string, userId: string): Promise<boolean> {
  const row = await prisma.conversationParticipant.findUnique({
    where: { conversationId_userId: { conversationId, userId } },
  });
  return !!row;
}

export function initSocketServer(httpServer: HttpServer) {
  const io = new IOServer(httpServer, {
    cors: { origin: env.frontendUrl, credentials: true },
  });

  io.use(async (socket: AuthedSocket, next) => {
    try {
      const token = parseCookie(socket.handshake.headers.cookie, 'vynzo_token');
      if (!token) return next(new Error('NOT_AUTHENTICATED'));

      const payload = verifyToken(token);
      const user = await prisma.user.findUnique({ where: { id: payload.userId } });
      if (!user || user.accountStatus !== 'active') return next(new Error('NOT_AUTHENTICATED'));

      if (payload.accountSessionId) {
        const session = await prisma.accountSession.findUnique({ where: { id: payload.accountSessionId } });
        if (!session || session.userId !== user.id) return next(new Error('SESSION_REVOKED'));
      }

      socket.userId = user.id;
      socket.accountSessionId = payload.accountSessionId;
      next();
    } catch {
      next(new Error('NOT_AUTHENTICATED'));
    }
  });

  io.on('connection', async (socket: AuthedSocket) => {
    const userId = socket.userId as string;

    if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
    onlineUsers.get(userId)!.add(socket.id);

    socket.join(`user:${userId}`);

    const participants = await prisma.conversationParticipant.findMany({
      where: { userId },
      select: { conversationId: true },
    });
    const conversationIds = participants.map((p) => p.conversationId);
    conversationIds.forEach((id) => socket.join(`conversation:${id}`));

    if (onlineUsers.get(userId)!.size === 1) {
      conversationIds.forEach((id) => {
        socket.to(`conversation:${id}`).emit('presence:online', { userId });
      });

      const deliveredAt = new Date();
      await prisma.conversationParticipant.updateMany({
        where: { conversationId: { in: conversationIds }, userId },
        data: { lastDeliveredAt: deliveredAt },
      });
      conversationIds.forEach((id) => {
        socket.to(`conversation:${id}`).emit('conversation:delivered', { conversationId: id, userId, deliveredAt });
      });
    }

    socket.on('message:send', async ({ conversationId, content, mediaUrl, mediaType, voiceDuration }: {
      conversationId: string;
      content: string;
      mediaUrl?: string;
      mediaType?: 'image' | 'voice';
      voiceDuration?: number;
      replyToId?: string;
    }, ack?: (res: { success: boolean; data?: unknown; error?: string; delivered?: boolean }) => void) => {
      try {
        const trimmed = (content || '').trim();
        if (!trimmed && !mediaUrl) {
          if (ack) ack({ success: false, error: 'EMPTY_MESSAGE' });
          return;
        }
        if (!conversationId) {
          if (ack) ack({ success: false, error: 'MISSING_CONVERSATION' });
          return;
        }

        const isParticipantRow = await prisma.conversationParticipant.findUnique({
          where: { conversationId_userId: { conversationId, userId } },
        });
        if (!isParticipantRow) {
          if (ack) ack({ success: false, error: 'NOT_A_PARTICIPANT' });
          return;
        }

        const otherParticipant = await prisma.conversationParticipant.findFirst({
          where: { conversationId, userId: { not: userId } },
        });
        if (otherParticipant) {
          const blocked = await isEitherBlocked(userId, otherParticipant.userId);
          if (blocked) {
            if (ack) ack({ success: false, error: 'BLOCKED' });
            return;
          }

          const target = await prisma.user.findUnique({
            where: { id: otherParticipant.userId },
            select: { messagePermission: true },
          });
          if (target?.messagePermission === 'none') {
            if (ack) ack({ success: false, error: 'MESSAGES_DISABLED' });
            return;
          }
          if (target?.messagePermission === 'followers') {
            const isFollower = await prisma.follow.findUnique({
              where: { followerId_followingId: { followerId: userId, followingId: otherParticipant.userId } },
            });
            if (!isFollower) {
              if (ack) ack({ success: false, error: 'MESSAGES_RESTRICTED' });
              return;
            }
          }
        }

        if (replyToId) {
          const parent = await prisma.message.findFirst({ where: { id: replyToId, conversationId, hiddenFor: { none: { userId } } } });
          if (!parent) {
            if (ack) ack({ success: false, error: 'INVALID_REPLY_TARGET' });
            return;
          }
        }

        const message = await prisma.message.create({
          data: {
            conversationId,
            senderId: userId,
            content: trimmed,
            mediaUrl: mediaUrl || null,
            mediaType: mediaUrl ? mediaType || 'image' : null,
            voiceDuration: mediaType === 'voice' ? voiceDuration || null : null,
            replyToId: replyToId || null,
          },
          include: {
            sender: { select: { id: true, username: true, displayName: true, profilePictureUrl: true } },
            replyTo: { include: { sender: { select: { id: true, username: true, displayName: true, profilePictureUrl: true } } } },
            reactions: { select: { userId: true, emoji: true } },
          },
        });

        await prisma.conversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
        io.to(`conversation:${conversationId}`).emit('message:new', message);

        let delivered = false;
        if (otherParticipant && isUserOnline(otherParticipant.userId)) {
          await prisma.conversationParticipant.update({ where: { id: otherParticipant.id }, data: { lastDeliveredAt: new Date() } });
          delivered = true;
        }

        if (otherParticipant) {
          pushNewMessage(message, otherParticipant, userId).catch((err) => console.error('[push] chat push failed', err));
        }

        if (ack) ack({ success: true, data: message, delivered });
      } catch {
        if (ack) ack({ success: false, error: 'SEND_FAILED' });
      }
    });

    socket.on('message:edit', async ({ messageId, content }: { messageId: string; content: string }, ack?: (res: { success: boolean; data?: unknown; error?: string }) => void) => {
      try {
        const message = await prisma.message.findUnique({ where: { id: messageId } });
        if (!message || message.senderId !== userId || message.deletedAt) { if (ack) ack({ success: false, error: 'EDIT_FORBIDDEN' }); return; }
        if (!(await isParticipant(message.conversationId, userId))) { if (ack) ack({ success: false, error: 'NOT_A_PARTICIPANT' }); return; }
        const value = (content || '').trim();
        if (!value) { if (ack) ack({ success: false, error: 'EMPTY_MESSAGE' }); return; }
        const updated = await prisma.message.update({
          where: { id: messageId },
          data: { content: value, editedAt: new Date() },
          include: {
            sender: { select: { id: true, username: true, displayName: true, profilePictureUrl: true } },
            replyTo: { include: { sender: { select: { id: true, username: true, displayName: true, profilePictureUrl: true } } } },
            reactions: { select: { userId: true, emoji: true } },
          },
        });
        io.to('conversation:' + message.conversationId).emit('message:edited', updated);
        if (ack) ack({ success: true, data: updated });
      } catch { if (ack) ack({ success: false, error: 'EDIT_FAILED' }); }
    });

    socket.on('message:reaction', async ({ messageId, emoji }: { messageId: string; emoji: string }, ack?: (res: { success: boolean; data?: unknown; error?: string }) => void) => {
      try {
        const message = await prisma.message.findUnique({ where: { id: messageId } });
        if (!message || !(await isParticipant(message.conversationId, userId))) { if (ack) ack({ success: false, error: 'NOT_ALLOWED' }); return; }
        const allowed = ['❤️','😂','😮','😢','😡','👍','👎'];
        if (!allowed.includes(emoji)) { if (ack) ack({ success: false, error: 'INVALID_REACTION' }); return; }
        const existing = await prisma.messageReaction.findUnique({ where: { messageId_userId: { messageId, userId } } });
        if (existing && existing.emoji === emoji) await prisma.messageReaction.delete({ where: { id: existing.id } });
        else await prisma.messageReaction.upsert({ where: { messageId_userId: { messageId, userId } }, update: { emoji }, create: { messageId, userId, emoji } });
        const reactions = await prisma.messageReaction.findMany({ where: { messageId }, select: { userId: true, emoji: true } });
        io.to('conversation:' + message.conversationId).emit('message:reaction', { messageId, reactions });
        if (ack) ack({ success: true, data: reactions });
      } catch { if (ack) ack({ success: false, error: 'REACTION_FAILED' }); }
    });

    socket.on('message:pin', async ({ messageId }: { messageId: string }, ack?: (res: { success: boolean; data?: unknown; error?: string }) => void) => {
      try {
        const message = await prisma.message.findUnique({ where: { id: messageId } });
        if (!message || !(await isParticipant(message.conversationId, userId))) { if (ack) ack({ success: false, error: 'NOT_ALLOWED' }); return; }
        const pinnedAt = message.pinnedAt ? null : new Date();
        const updated = await prisma.message.update({ where: { id: messageId }, data: { pinnedAt, pinnedById: pinnedAt ? userId : null } });
        io.to('conversation:' + message.conversationId).emit('message:pinned', { messageId, pinnedAt: updated.pinnedAt, pinnedById: updated.pinnedById });
        if (ack) ack({ success: true, data: updated });
      } catch { if (ack) ack({ success: false, error: 'PIN_FAILED' }); }
    });

    socket.on('message:delete', async ({ messageId, mode }: { messageId: string; mode: 'me' | 'everyone' }, ack?: (res: { success: boolean; error?: string }) => void) => {
      try {
        if (!messageId) {
          if (ack) ack({ success: false, error: 'MISSING_ID' });
          return;
        }
        if (mode === 'everyone') {
          const { conversationId } = await deleteMessageForEveryone(userId, messageId);
          io.to(`conversation:${conversationId}`).emit('message:deleted', { messageId });
        } else {
          await deleteMessageForMe(userId, messageId);
        }
        if (ack) ack({ success: true });
      } catch {
        if (ack) ack({ success: false, error: 'DELETE_FAILED' });
      }
    });

    socket.on('typing:start', async ({ conversationId }: { conversationId: string }) => {
      if (!conversationId) return;
      if (!(await isParticipant(conversationId, userId))) return;
      socket.to(`conversation:${conversationId}`).emit('typing:start', { conversationId, userId });
    });

    socket.on('typing:stop', async ({ conversationId }: { conversationId: string }) => {
      if (!conversationId) return;
      if (!(await isParticipant(conversationId, userId))) return;
      socket.to(`conversation:${conversationId}`).emit('typing:stop', { conversationId, userId });
    });

    socket.on('conversation:read', async ({ conversationId }: { conversationId: string }) => {
      if (!conversationId) return;
      if (!(await isParticipant(conversationId, userId))) return;

      const readAt = new Date();
      await prisma.conversationParticipant.updateMany({ where: { conversationId, userId }, data: { lastReadAt: readAt, lastDeliveredAt: readAt } });
      socket.to(`conversation:${conversationId}`).emit('conversation:read', { conversationId, userId, readAt });
    });

    socket.on('disconnect', async () => {
      const set = onlineUsers.get(userId);
      if (!set) return;
      set.delete(socket.id);
      if (set.size === 0) {
        onlineUsers.delete(userId);
        await prisma.user.update({ where: { id: userId }, data: { lastActiveAt: new Date() } }).catch(() => {});
        conversationIds.forEach((id) => {
          socket.to(`conversation:${id}`).emit('presence:offline', { userId, lastActiveAt: new Date() });
        });
      }
    });
  });

  return io;
}
