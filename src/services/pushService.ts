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
  payload: { title: string; body: string; url?: string }
) {
  const a = getAuth();
  if (!a || !projectId) {
    console.warn('[push] skipped: FIREBASE_SERVICE_ACCOUNT_JSON missing or invalid');
    return;
  }
  const tokens = await prisma.pushToken.findMany({ where: { userId }, select: { token: true } });
  console.log(`[push] user ${userId} has ${tokens.length} device token(s)`);
  if (!tokens.length) return;

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
            notification: { title: payload.title, body: payload.body },
            data: { url: payload.url ?? '/notifications' },
            android: { priority: 'HIGH', notification: { channel_id: 'frianzo_default' } },
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
