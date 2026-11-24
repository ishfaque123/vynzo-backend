import { prisma } from '../config/prisma';

// Permanent data-retention cleanup (owner-ordered 2026-10-21 after the
// MySQL disk-full incident). Deletes ONLY stale counting/log rows so the
// database volume does not keep growing with exhaust data:
//
//   - usage_pings older than 7 days (app-open counters; getPings is only
//     used for recent ranges)
//   - notifications older than 30 days
//   - email_verification_codes whose expiry has passed
//   - auth_failure_logs older than 30 days
//   - device_sessions whose expiry has passed (added 2026-10-22 on the
//     owner's order; an expired session is already unusable per
//     getDeviceSession, and its account_sessions cascade-delete)
//
// Device sessions are NEVER deleted for being idle. An unexpired
// device_sessions row is still a valid login — getDeviceSession and
// getOrCreateDeviceSession only ever test expiresAt — and deleting one
// cascade-deletes its account_sessions, which makes auth reject the
// user's token as SESSION_REVOKED: a user who never logged out is
// silently signed out (the blank-blue-screen bug, 2026-11-24). Owner
// ruling 2026-11-24: the 7-day cleanup ordered on 2026-11-21 was only
// ever meant for devices that are ALREADY logged out; a still-logged-in
// device's session must never be removed and nobody may be logged out
// by this sweep. The Devices list's "last 7 days" view is a read-level
// filter in deviceService.listDevices and is unaffected by this sweep.
//
// It NEVER touches real content: posts, comments, reels, users, follows,
// likes, messages, or view rows (post_views / reel_views are the source of
// the displayed view counts, so they are deliberately excluded).
//
// Every delete runs in isolation: one failing table can neither block the
// others nor crash the server. After the deletes it logs the total on-disk
// database size and warns loudly once files pass 3,500 MB (the volume is
// 5 GB), so a future disk-full is seen long before it bites.

const DAY_MS = 24 * 60 * 60 * 1000;
const PING_RETENTION_MS = 7 * DAY_MS;
const NOTIFICATION_RETENTION_MS = 30 * DAY_MS;
const AUTH_LOG_RETENTION_MS = 30 * DAY_MS;
const DISK_WARN_MB = 3500;

export interface RetentionResult {
  usagePings: number;
  notifications: number;
  expiredCodes: number;
  authFailureLogs: number;
  deviceSessions: number;
  totalDeleted: number;
  filesMb: number | null;
}

async function safeDelete(label: string, run: () => Promise<{ count: number }>): Promise<number> {
  try {
    const result = await run();
    return result.count;
  } catch (err) {
    console.error(`[retention] ${label} delete failed:`, err);
    return 0;
  }
}

async function getTotalFilesMb(): Promise<number | null> {
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ total_mb: number }>>(
      `SELECT CAST(SUM(total_extents * extent_size) AS DOUBLE) / 1048576 AS total_mb
         FROM information_schema.files`,
    );
    const mb = Number(rows[0]?.total_mb);
    return Number.isFinite(mb) ? Math.round(mb * 10) / 10 : null;
  } catch (err) {
    console.error('[retention] disk size check failed:', err);
    return null;
  }
}

export async function runDataRetention(): Promise<RetentionResult> {
  const now = Date.now();

  const usagePings = await safeDelete('usage_pings', () =>
    prisma.usagePing.deleteMany({
      where: { pingedAt: { lt: new Date(now - PING_RETENTION_MS) } },
    }),
  );

  const notifications = await safeDelete('notifications', () =>
    prisma.notification.deleteMany({
      where: { createdAt: { lt: new Date(now - NOTIFICATION_RETENTION_MS) } },
    }),
  );

  const expiredCodes = await safeDelete('email_verification_codes', () =>
    prisma.emailVerificationCode.deleteMany({
      where: { expiresAt: { lt: new Date(now) } },
    }),
  );

  const authFailureLogs = await safeDelete('auth_failure_logs', () =>
    prisma.authFailureLog.deleteMany({
      where: { createdAt: { lt: new Date(now - AUTH_LOG_RETENTION_MS) } },
    }),
  );

  // Only expired device sessions are removed. An expired row is an
  // already-ended session: getDeviceSession returns null for it, so it
  // can never authenticate again and deleting it signs nobody out.
  // Idle-but-unexpired rows are live logins and are kept no matter how
  // long the device has been away (owner ruling 2026-11-24, above).
  const deviceSessions = await safeDelete('device_sessions', () =>
    prisma.deviceSession.deleteMany({
      where: { expiresAt: { lt: new Date(now) } },
    }),
  );

  const totalDeleted = usagePings + notifications + expiredCodes + authFailureLogs + deviceSessions;
  const filesMb = await getTotalFilesMb();

  console.log(
    `[retention] deleted ${totalDeleted} stale rows ` +
      `(pings=${usagePings}, notifications=${notifications}, expiredCodes=${expiredCodes}, authLogs=${authFailureLogs}, deviceSessions=${deviceSessions}); ` +
      `db files=${filesMb === null ? 'unknown' : filesMb + ' MB'}`,
  );

  if (filesMb !== null && filesMb > DISK_WARN_MB) {
    console.error(
      `[retention] WARNING: database files are ${filesMb} MB — above the ${DISK_WARN_MB} MB warning line (volume is 5 GB).`,
    );
  }

  return { usagePings, notifications, expiredCodes, authFailureLogs, deviceSessions, totalDeleted, filesMb };
}
