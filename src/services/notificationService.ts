import { prisma } from '../config/prisma';

type NotificationType =
  | 'follow'
  | 'post_like'
  | 'post_comment'
  | 'comment_like'
  | 'comment_reply'
  | 'account_restricted'
  | 'account_banned';

function toAuthorDTO(user: any) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    profilePictureUrl: user.profilePictureUrl,
  };
}

export async function createNotification(params: {
  userId: string;
  actorId?: string | null;
  type: NotificationType;
  postId?: string;
  commentId?: string;
}) {
  if (params.actorId && params.actorId === params.userId) return null;
  return prisma.notification.create({
    data: {
      userId: params.userId,
      actorId: params.actorId ?? null,
      type: params.type,
      postId: params.postId,
      commentId: params.commentId,
    },
  });
}

export async function getNotifications(userId: string) {
  const notifications = await prisma.notification.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { actor: true },
  });
  return notifications.map((n) => ({
    id: n.id,
    type: n.type,
    read: n.read,
    createdAt: n.createdAt,
    postId: n.postId,
    commentId: n.commentId,
    actor: n.actor ? toAuthorDTO(n.actor) : null,
  }));
}

export async function markAllRead(userId: string) {
  await prisma.notification.updateMany({ where: { userId, read: false }, data: { read: true } });
  return { success: true };
}

export async function getUnreadCount(userId: string) {
  const count = await prisma.notification.count({ where: { userId, read: false } });
  return { count };
}
