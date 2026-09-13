import { Server as IOServer, Socket } from 'socket.io';
import { Server as HttpServer } from 'http';
import { verifyToken } from '../utils/jwt';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { isEitherBlocked } from '../services/blockService';
import { deleteMessageForMe, deleteMessageForEveryone } from '../services/messageService';

interface AuthedSocket extends Socket {
  userId?: string;
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

// Every conversation-scoped event (read receipts, typing, sending) must
// verify the socket's own userId is actually a participant of the target
// conversationId before touching the DB or broadcasting to that room.
// socket.to(room) delivers to whoever is IN the room regardless of whether
// the emitting socket is a member of it — so skipping this check lets any
// authenticated user inject fake events into a conversation they were
// never part of, as long as they know or guess its id.
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

      socket.userId = user.id;
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

    socket.on(
      'message:send',
      async (
        {
          conversationId,
          content,
          mediaUrl,
          mediaType,
          voiceDuration,
        }: {
          conversationId: string;
          content: string;
          mediaUrl?: string;
          mediaType?: 'image' | 'voice';
          voiceDuration?: number;
        },
        ack?: (res: { success: boolean; data?: unknown; error?: string; delivered?: boolean }) => void
      ) => {
        try {
          const trimmed = (content || '').trim();
          if (!trimmed && !mediaUrl) return;
          if (!conversationId) return;

          const isParticipantRow = await prisma.conversationParticipant.findUnique({
            where: { conversationId_userId: { conversationId, userId } },
          });
          if (!isParticipantRow) return;

          const otherParticipant = await prisma.conversationParticipant.findFirst({
            where: { conversationId, userId: { not: userId } },
          });
          if (otherParticipant) {
            const blocked = await isEitherBlocked(userId, otherParticipant.userId);
            if (blocked) {
              if (ack) ack({ success: false, error: 'BLOCKED' });
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
            },
            include: {
              sender: {
                select: { id: true, username: true, displayName: true, profilePictureUrl: true },
              },
            },
          });

          await prisma.conversation.update({
            where: { id: conversationId },
            data: { updatedAt: new Date() },
          });

          io.to(`conversation:${conversationId}`).emit('message:new', message);

          let delivered = false;
          if (otherParticipant && isUserOnline(otherParticipant.userId)) {
            await prisma.conversationParticipant.update({
              where: { id: otherParticipant.id },
              data: { lastDeliveredAt: new Date() },
            });
            delivered = true;
          }

          if (ack) ack({ success: true, data: message, delivered });
        } catch {
          if (ack) ack({ success: false, error: 'SEND_FAILED' });
        }
      }
    );

    socket.on(
      'message:delete',
      async (
        { messageId, mode }: { messageId: string; mode: 'me' | 'everyone' },
        ack?: (res: { success: boolean; error?: string }) => void
      ) => {
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
      }
    );

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
      await prisma.conversationParticipant.updateMany({
        where: { conversationId, userId },
        data: { lastReadAt: readAt, lastDeliveredAt: readAt },
      });
      socket.to(`conversation:${conversationId}`).emit('conversation:read', { conversationId, userId, readAt });
    });

    socket.on('disconnect', async () => {
      const set = onlineUsers.get(userId);
      if (!set) return;
      set.delete(socket.id);
      if (set.size === 0) {
        onlineUsers.delete(userId);
        await prisma.user
          .update({ where: { id: userId }, data: { lastActiveAt: new Date() } })
          .catch(() => {});
        conversationIds.forEach((id) => {
          socket.to(`conversation:${id}`).emit('presence:offline', { userId, lastActiveAt: new Date() });
        });
      }
    });
  });

  return io;
}
