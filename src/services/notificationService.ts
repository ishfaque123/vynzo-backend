import { prisma } from '../config/prisma';
import { sendPushToUser } from './pushService';

type NotificationType =
  | 'follow'
  | 'post_like'
  | 'post_comment'
  | 'comment_like'
  | 'comment_reply'
  | 'post_share'
  | 'new_device_login'
  | 'account_restricted'
  | 'account_banned';

// Toggle-style actions (like/unlike, follow/unfollow) must not notify the
// same person about the same thing again and again.
const DEDUPE_TYPES = new Set<string>(['follow', 'post_like', 'comment_like']);
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

function toAuthorDTO(user: any) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    profilePictureUrl: user.profilePictureUrl,
  };
}

async function createNotificationRecord(params: {
  userId: string;
  actorId?: string | null;
  type: NotificationType;
  postId?: string;
  commentId?: string;
}) {
  if (params.actorId && params.actorId === params.userId) return null;
  if (params.actorId && DEDUPE_TYPES.has(params.type)) {
    const recent = await prisma.notification.findFirst({
      where: {
        userId: params.userId,
        actorId: params.actorId,
        type: params.type,
        postId: params.postId ?? null,
        commentId: params.commentId ?? null,
        createdAt: { gte: new Date(Date.now() - DEDUPE_WINDOW_MS) },
      },
      select: { id: true },
    });
    if (recent) return null;
  }
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

export async function deleteNotifications(userId: string, ids: string[]) {
  if (!ids.length) return { deletedCount: 0 };
  const result = await prisma.notification.deleteMany({
    where: { userId, id: { in: ids } },
  });
  return { deletedCount: result.count };
}

export async function deleteAllNotifications(userId: string) {
  const result = await prisma.notification.deleteMany({ where: { userId } });
  return { deletedCount: result.count };
}

type NotificationParams = Parameters<typeof createNotificationRecord>[0];

function withOthers(name: string, others: number): string {
  return others > 0 ? `${name} and ${others} other${others > 1 ? 's' : ''}` : name;
}

const PUSH_TEXT: Record<string, (name: string, others: number) => string> = {
  follow: (n, o) => `${withOthers(n, o)} started following you`,
  post_like: (n, o) => `${withOthers(n, o)} liked your post`,
  post_comment: (n, o) => `${withOthers(n, o)} commented on your post`,
  comment_like: (n, o) => `${withOthers(n, o)} liked your comment`,
  comment_reply: (n, o) => `${withOthers(n, o)} replied to your comment`,
  post_share: (n, o) => `${withOthers(n, o)} shared your post`,
  new_device_login: () => 'New login detected on your account',
  account_restricted: () => 'Your account has been restricted',
  account_banned: () => 'Your account has been banned',
};

// Several people doing the same thing to the same target are merged into
// one phone notification ("A and 2 others liked your post").
const GROUPED_TYPES = new Set<string>(['follow', 'post_like', 'post_comment', 'comment_like', 'comment_reply', 'post_share']);

async function sendPushForNotification(params: NotificationParams) {
  let name = 'Someone';
  let username: string | null = null;
  if (params.actorId) {
    const actor = await prisma.user.findUnique({
      where: { id: params.actorId },
      select: { displayName: true, username: true },
    });
    name = actor?.displayName || actor?.username || name;
    username = actor?.username ?? null;
  }

  const grouped = GROUPED_TYPES.has(params.type);
  let others = 0;
  if (grouped) {
    const recent = await prisma.notification.findMany({
      where: {
        userId: params.userId,
        type: params.type,
        read: false,
        postId: params.postId ?? null,
        commentId: params.commentId ?? null,
        createdAt: { gte: new Date(Date.now() - DEDUPE_WINDOW_MS) },
      },
      select: { actorId: true },
      distinct: ['actorId'],
      take: 100,
    });
    others = Math.max(0, recent.length - 1);
  }

  const makeText = PUSH_TEXT[params.type];
  const body = makeText ? makeText(name, others) : 'New notification';
  let url = '/notifications';
  if (params.type === 'follow' && username) url = `/u/${username}`;
  else if (params.postId) url = `/post/${params.postId}`;
  const tag = grouped ? `${params.type}:${params.postId ?? ''}:${params.commentId ?? ''}` : undefined;
  await sendPushToUser(params.userId, { title: 'Frianzo', body, url, tag });
}

export async function createNotification(params: NotificationParams) {
  const notification = await createNotificationRecord(params);
  if (notification) {
    sendPushForNotification(params).catch((err) => console.error('[push] send failed', err));
  }
  return notification;
}
