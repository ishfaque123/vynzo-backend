import { Server as IOServer, Socket } from 'socket.io';
import { Server as HttpServer } from 'http';
import { verifyToken } from '../utils/jwt';
import { prisma } from '../config/prisma';
import { env } from '../config/env';

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
    }

    socket.on(
      'message:send',
      async (
        { conversationId, content }: { conversationId: string; content: string },
        ack?: (res: { success: boolean; data?: unknown; error?: string }) => void
      ) => {
        try {
          if (!content?.trim() || !conversationId) return;

          const isParticipant = await prisma.conversationParticipant.findUnique({
            where: { conversationId_userId: { conversationId, userId } },
          });
          if (!isParticipant) return;

          const message = await prisma.message.create({
            data: { conversationId, senderId: userId, content: content.trim() },
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
          if (ack) ack({ success: true, data: message });
        } catch {
          if (ack) ack({ success: false, error: 'SEND_FAILED' });
        }
      }
    );

    socket.on('typing:start', ({ conversationId }: { conversationId: string }) => {
      if (!conversationId) return;
      socket.to(`conversation:${conversationId}`).emit('typing:start', { conversationId, userId });
    });

    socket.on('typing:stop', ({ conversationId }: { conversationId: string }) => {
      if (!conversationId) return;
      socket.to(`conversation:${conversationId}`).emit('typing:stop', { conversationId, userId });
    });

    socket.on('conversation:read', async ({ conversationId }: { conversationId: string }) => {
      if (!conversationId) return;
      await prisma.conversationParticipant.updateMany({
        where: { conversationId, userId },
        data: { lastReadAt: new Date() },
      });
      socket.to(`conversation:${conversationId}`).emit('conversation:read', { conversationId, userId });
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
