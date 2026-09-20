import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';

const allowedReasons = new Set(['spam', 'harassment', 'hate_speech', 'violence', 'nudity', 'misinformation', 'other']);

async function ensureViewTable() {
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS reel_views (id VARCHAR(191) NOT NULL PRIMARY KEY, reel_id VARCHAR(191) NOT NULL, viewer_id VARCHAR(191) NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), KEY reel_views_reel_id_idx (reel_id), KEY reel_views_viewer_id_idx (viewer_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  try {
    await prisma.$executeRawUnsafe(`DELETE rv1 FROM reel_views rv1 INNER JOIN reel_views rv2 ON rv1.reel_id = rv2.reel_id AND rv1.viewer_id = rv2.viewer_id AND rv1.id > rv2.id`);
  } catch {}
  try { await prisma.$executeRawUnsafe(`ALTER TABLE reel_views ADD UNIQUE KEY reel_view_unique (reel_id, viewer_id)`); } catch {}
}

async function ensureReportTable() {
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS reel_reports (id VARCHAR(191) NOT NULL PRIMARY KEY, reel_id VARCHAR(191) NOT NULL, reporter_id VARCHAR(191) NOT NULL, reason VARCHAR(50) NOT NULL DEFAULT 'other', details VARCHAR(500) NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), UNIQUE KEY reel_report_unique (reel_id, reporter_id), KEY reel_reports_reel_id_idx (reel_id), KEY reel_reports_reporter_id_idx (reporter_id), CONSTRAINT reel_reports_reel_fk FOREIGN KEY (reel_id) REFERENCES reels(id) ON DELETE CASCADE, CONSTRAINT reel_reports_reporter_fk FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

export async function reportReel(userId: string, reelId: string, reason: string, details?: string) {
  if (!allowedReasons.has(reason)) throw new ApiError(400, 'INVALID_REPORT_REASON', 'Invalid report reason.');
  const reel = await prisma.reel.findUnique({ where: { id: reelId }, select: { id: true, userId: true } });
  if (!reel) throw new ApiError(404, 'REEL_NOT_FOUND', 'Reel not found.');
  if (reel.userId === userId) throw new ApiError(400, 'CANNOT_REPORT_OWN_REEL', 'You cannot report your own reel.');
  if (details && details.length > 500) throw new ApiError(400, 'DETAILS_TOO_LONG', 'Report details are too long.');
  await ensureReportTable();
  await prisma.$executeRawUnsafe(`INSERT IGNORE INTO reel_reports (id, reel_id, reporter_id, reason, details) VALUES (UUID(), ?, ?, ?, ?)`, reelId, userId, reason, details ?? null);
  return { reported: true };
}

export async function recordReelView(userId: string, reelId: string) {
  const reel = await prisma.reel.findUnique({ where: { id: reelId }, select: { id: true } });
  if (!reel) throw new ApiError(404, 'REEL_NOT_FOUND', 'Reel not found.');
  await ensureViewTable();
  await prisma.$executeRawUnsafe(`INSERT IGNORE INTO reel_views (id, reel_id, viewer_id) VALUES (UUID(), ?, ?)`, reelId, userId);
  const rows = await prisma.$queryRawUnsafe<Array<{ viewCount: bigint }>>(`SELECT COUNT(*) AS viewCount FROM reel_views WHERE reel_id = ?`, reelId);
  return { viewed: true, viewCount: Number(rows[0]?.viewCount ?? 0) };
}
