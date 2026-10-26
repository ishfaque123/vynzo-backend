import { prisma } from '../config/prisma';
import { sendPushToUser } from './pushService';

// Ensure the detail column exists on notifications (safe: only ADDs, never alters/drops).
let detailColReady = false;
async function ensureDetailColumn() {
  if (detailColReady) return;
  try {
    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notifications' AND COLUMN_NAME = 'detail'`
    );
    if (Number(rows[0]?.c ?? 0) === 0) {
      await prisma.$executeRawUnsafe(`ALTER TABLE notifications ADD COLUMN detail TEXT NULL`);
      console.log('[notifications] added detail column');
    }
  } catch (err) {
    console.error('[notifications] detail column ensure failed', err);
  }
  detailColReady = true;
}

// Ensure the preferences table exists (safe: IF NOT EXISTS, no data loss).
let prefsTableReady = false;
async function ensurePrefsTable() {
  if (prefsTableReady) return;
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS notification_preferences (id VARCHAR(191) NOT NULL PRIMARY KEY, user_id VARCHAR(191) NOT NULL, category VARCHAR(191) NOT NULL, enabled BOOLEAN NOT NULL DEFAULT true, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), UNIQUE KEY notification_preferences_user_id_category_key (user_id, category)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  prefsTableReady = true;
}

type NotificationType =
  | 'follow'
  | 'post_like'
  | 'post_comment'
  | 'comment_like'
  | 'comment_reply'
  | 'post_share'
  | 'new_device_login'
  | 'account_restricted'
  | 'account_banned'
  | 'reel_like'
  | 'reel_comment'
  | 'reel_reply'
  | 'comment_mention'
  | 'verification_approved'
  | 'verification_rejected'
  | 'comment_removed'
  | 'post_removed'
  | 'reel_removed'
  | 'messaging_restricted';

// Toggle-style actions (like/unlike, follow/unfollow) must not notify the
// same person about the same thing again and again.
const DEDUPE_TYPES = new Set<string>(['follow', 'post_like', 'comment_like', 'reel_like']);
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

function toAuthorDTO(user: any) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    profilePictureUrl: user.profilePictureUrl,
    isVerified: !!user.isVerified,
  };
}

async function createNotificationRecord(params: {
  userId: string;
  actorId?: string | null;
  type: NotificationType;
  postId?: string;
  commentId?: string;
  reelId?: string;
  reaction?: string; // only used for the push text, not stored
  detail?: string; // stored, shown in-app (e.g. moderation reason)
}) {
  if (params.actorId && params.actorId === params.userId) return null;
  if (params.actorId && DEDUPE_TYPES.has(params.type)) {
    const recent = await prisma.notification.findFirst({
      where: {
        userId: params.userId,
        actorId: params.actorId,
        type: params.type as any,
        postId: params.postId ?? null,
        commentId: params.commentId ?? null,
        reelId: params.reelId ?? null,
        createdAt: { gte: new Date(Date.now() - DEDUPE_WINDOW_MS) },
      },
      select: { id: true },
    });
    if (recent) return null;
  }
  await ensureDetailColumn();
  const data: any = {
    userId: params.userId,
    actorId: params.actorId ?? null,
    type: params.type as any,
    postId: params.postId,
    commentId: params.commentId,
    reelId: params.reelId,
  };
  if (params.detail) data.detail = params.detail;
  return prisma.notification.create({ data });
}

export async function getNotifications(userId: string) {
  const notifications = await prisma.notification.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { actor: true },
  });
  await ensureDetailColumn();
  return notifications.map((n) => ({
    id: n.id,
    type: n.type,
    read: n.read,
    detail: (n as any).detail ?? null,
    createdAt: n.createdAt,
    postId: n.postId,
    commentId: n.commentId,
    reelId: n.reelId,
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

const REACTION_VERB: Record<string, string> = {
  like: 'liked',
  love: 'loved',
  haha: 'reacted 😆 to',
  wow: 'reacted 😮 to',
  sad: 'reacted 😢 to',
  angry: 'reacted 😠 to',
};

function reactionVerb(reaction: string | undefined, others: number): string {
  const r = reaction ?? 'like';
  if (others > 0) return r === 'like' ? 'liked' : 'reacted to';
  return REACTION_VERB[r] ?? 'liked';
}

const PUSH_TEXT: Record<string, (name: string, others: number, reaction?: string) => string> = {
  follow: (n, o) => `${withOthers(n, o)} started following you`,
  post_like: (n, o, r) => `${withOthers(n, o)} ${reactionVerb(r, o)} your post`,
  post_comment: (n, o) => `${withOthers(n, o)} commented on your post`,
  comment_like: (n, o, r) => `${withOthers(n, o)} ${reactionVerb(r, o)} your comment`,
  comment_reply: (n, o) => `${withOthers(n, o)} replied to your comment`,
  post_share: (n, o) => `${withOthers(n, o)} shared your post`,
  reel_like: (n, o) => `${withOthers(n, o)} liked your reel`,
  reel_comment: (n, o) => `${withOthers(n, o)} commented on your reel`,
  reel_reply: (n, o) => `${withOthers(n, o)} replied to your comment on a reel`,
  comment_mention: (n, o) => `${withOthers(n, o)} mentioned you`,
  new_device_login: () => 'New login detected on your account',
  account_restricted: () => 'Your account has been restricted',
  account_banned: () => 'Your account has been banned',
  verification_approved: () => 'Your account has been verified',
  verification_rejected: () => 'Your verification request was rejected',
  // reason is passed via the `reaction` slot (display-only, not stored)
  comment_removed: (n, o, r) => `Your comment was removed${r ? ` for ${r}` : ''}`,
  post_removed: (n, o, r) => `Your post was removed${r ? ` for ${r}` : ''}`,
  reel_removed: (n, o, r) => `Your reel was removed${r ? ` for ${r}` : ''}`,
  messaging_restricted: (n, o, r) => `Messaging restricted${r ? `: ${r}` : ''}`,
  viral_post: (n) => `🔥 ${n}'s post is going viral!`,
};

// Several people doing the same thing to the same target are merged into
// one phone notification ("A and 2 others liked your post").
const GROUPED_TYPES = new Set<string>([
  'follow', 'post_like', 'post_comment', 'comment_like', 'comment_reply', 'post_share',
  'reel_like', 'reel_comment', 'reel_reply', 'comment_mention',
]);

// Map notification types to user-facing preference categories.
function prefCategoryFor(type: string): string | null {
  if (type.endsWith('_like')) return 'likes';
  if (type === 'post_comment' || type === 'comment_reply' || type === 'reel_comment' || type === 'reel_reply') return 'comments';
  if (type === 'follow') return 'follows';
  if (type === 'comment_mention') return 'mentions';
  if (type === 'post_share') return 'shares';
  if (type === 'viral_post') return 'viral';
  return null; // system/security types always send
}

export async function isPushEnabled(userId: string, type: string): Promise<boolean> {
  const category = prefCategoryFor(type);
  if (!category) return true;
  await ensurePrefsTable();
  const pref = await (prisma as any).notificationPreference.findUnique({
    where: { userId_category: { userId, category } },
  });
  return pref ? !!pref.enabled : true; // default ON
}

export async function getPreferences(userId: string) {
  await ensurePrefsTable();
  const prefs = await (prisma as any).notificationPreference.findMany({ where: { userId } });
  const map: Record<string, boolean> = {};
  for (const p of prefs) map[p.category] = !!p.enabled;
  // Return all categories with defaults
  const categories = ['likes', 'comments', 'follows', 'mentions', 'shares', 'viral'];
  return categories.map((c) => ({ category: c, enabled: map[c] !== undefined ? map[c] : true }));
}

export async function setPreference(userId: string, category: string, enabled: boolean) {
  await ensurePrefsTable();
  const valid = ['likes', 'comments', 'follows', 'mentions', 'shares', 'viral'];
  if (!valid.includes(category)) throw new Error('INVALID_CATEGORY');
  return (prisma as any).notificationPreference.upsert({
    where: { userId_category: { userId, category } },
    update: { enabled },
    create: { userId, category, enabled },
  });
}

async function sendPushForNotification(params: NotificationParams) {
  // Respect user's notification preferences
  if (!(await isPushEnabled(params.userId, params.type))) return;
  let name = 'Someone';
  let username: string | null = null;
  let avatarUrl: string | null = null;
  if (params.actorId) {
    const actor = await prisma.user.findUnique({
      where: { id: params.actorId },
      select: { displayName: true, username: true, profilePictureUrl: true },
    });
    name = actor?.displayName || actor?.username || name;
    username = actor?.username ?? null;
    avatarUrl = actor?.profilePictureUrl ?? null;
  }

  const grouped = GROUPED_TYPES.has(params.type);
  let others = 0;
  if (grouped) {
    const recent = await prisma.notification.findMany({
      where: {
        userId: params.userId,
        type: params.type as any,
        read: false,
        postId: params.postId ?? null,
        commentId: params.commentId ?? null,
        reelId: params.reelId ?? null,
        createdAt: { gte: new Date(Date.now() - DEDUPE_WINDOW_MS) },
      },
      select: { actorId: true },
      distinct: ['actorId'],
      take: 100,
    });
    others = Math.max(0, recent.length - 1);
  }

  const makeText = PUSH_TEXT[params.type];
  let body = makeText ? makeText(name, others, params.reaction) : 'New notification';
  if (params.type === 'comment_mention') {
    body = `${withOthers(name, others)} ${params.commentId ? 'mentioned you in a comment' : 'tagged you in a post'}`;
  }
  let url = '/notifications';
  if (params.type === 'follow' && username) url = `/u/${username}`;
  else if (params.reelId) url = `/reels?id=${params.reelId}`;
  else if (params.postId) url = `/post/${params.postId}`;
  const tag = grouped ? `${params.type}:${params.postId ?? ''}:${params.commentId ?? ''}:${params.reelId ?? ''}` : undefined;
  await sendPushToUser(params.userId, {
    title: 'Frianzo',
    body,
    url,
    tag,
    avatarUrl: avatarUrl ?? undefined,
    type: params.type,
    postId: params.postId ?? undefined,
    commentId: params.commentId ?? undefined,
    reelId: params.reelId ?? undefined,
  });
}

export async function createNotification(params: NotificationParams) {
  const notification = await createNotificationRecord(params);
  if (notification) {
    sendPushForNotification(params).catch((err) => console.error('[push] send failed', err));
  }
  return notification;
}
