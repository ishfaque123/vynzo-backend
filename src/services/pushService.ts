import { GoogleAuth } from 'google-auth-library';
import { prisma } from '../config/prisma';

let auth: GoogleAuth | null = null;
let projectId: string | null = null;

function getAuth(): GoogleAuth | null {
  if (auth) return auth;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const credentials = JSON.parse(raw);
    projectId = credentials.project_id;
    auth = new GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
    });
    return auth;
  } catch (err) {
    console.error('[push] Invalid FIREBASE_SERVICE_ACCOUNT_JSON', err);
    return null;
  }
}

export async function registerPushToken(userId: string, token: string, platform = 'android') {
  await prisma.pushToken.upsert({
    where: { token },
    update: { userId, platform },
    create: { userId, token, platform },
  });
}

export async function removePushToken(userId: string, token: string) {
  await prisma.pushToken.deleteMany({ where: { userId, token } });
}

export async function sendPushToUser(
  userId: string,
  payload: {
    title: string;
    body: string;
    url?: string;
    tag?: string;
    // Rich-notification fields (all optional, all strings for FCM data).
    avatarUrl?: string;
    type?: string;
    conversationId?: string;
    postId?: string;
    commentId?: string;
    reelId?: string;
  }
) {
  const a = getAuth();
  if (!a || !projectId) {
    console.warn('[push] skipped: FIREBASE_SERVICE_ACCOUNT_JSON missing or invalid');
    return;
  }
  const tokens = await prisma.pushToken.findMany({ where: { userId }, select: { token: true } });
  console.log(`[push] user ${userId} has ${tokens.length} device token(s)`);
  if (!tokens.length) return;

  // Badge count for app icon (WhatsApp-style): unread notifications
  let badge = 0;
  try {
    badge = await prisma.notification.count({ where: { userId, read: false } });
  } catch {
    badge = 0;
  }

  const accessToken = await a.getAccessToken();
  if (!accessToken) {
    console.warn('[push] skipped: could not get Google access token');
    return;
  }

  await Promise.all(
    tokens.map(async ({ token }) => {
      const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            token,
            // Data-only message: the app builds the notification itself
            // (sender photo + inline Reply action). A notification payload
            // would make Android show the system notification instead, and
            // onMessageReceived would never run in background — so no
            // photo, no Reply button. Title/body/url/badge also travel in
            // data, so the CURRENT app build (which reads data fallbacks)
            // keeps showing plain notifications until it updates.
            data: {
              title: payload.title,
              body: payload.body,
              url: payload.url ?? '/notifications',
              badge: String(badge),
              ...(payload.tag ? { tag: payload.tag } : {}),
              ...(payload.avatarUrl ? { avatarUrl: payload.avatarUrl } : {}),
              ...(payload.type ? { type: payload.type } : {}),
              ...(payload.conversationId ? { conversationId: payload.conversationId } : {}),
              ...(payload.postId ? { postId: payload.postId } : {}),
              ...(payload.commentId ? { commentId: payload.commentId } : {}),
              ...(payload.reelId ? { reelId: payload.reelId } : {}),
            },
            android: { priority: 'HIGH' },
            apns: { payload: { aps: { alert: { title: payload.title, body: payload.body }, badge } } },
          },
        }),
      });
      console.log('[push] FCM response', res.status);
      if (!res.ok) {
        const text = await res.text();
        if (res.status === 404 || text.includes('UNREGISTERED')) {
          await prisma.pushToken.deleteMany({ where: { token } });
        } else {
          console.error('[push] FCM error', res.status, text.slice(0, 300));
        }
      }
    })
  );
}

// Log once at startup whether push is configured (no secrets printed).
if (getAuth()) console.log(`[push] FCM configured for project ${projectId}`);
else console.warn('[push] FCM NOT configured: FIREBASE_SERVICE_ACCOUNT_JSON missing or invalid');
