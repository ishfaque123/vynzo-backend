import { Request, Response, NextFunction } from 'express';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { r2Client } from '../config/r2';
import { env } from '../config/env';
import { sendSuccess } from '../utils/ApiResponse';

// READ-ONLY storage census (added 2026-10-20 for the old-media optimization
// analysis the owner ordered). Lists every object in the media bucket and
// aggregates counts/bytes per top-level folder, the largest objects, and
// "old" candidates: files stored BEFORE upload compression went live
// (2026-10-20) that are still big enough to be worth re-encoding.
// This handler never writes, uploads, or deletes anything.
const OLD_CUTOFF = new Date('2026-10-20T00:00:00.000Z');
const VIDEO_PREFIX = 'reels';
const IMAGE_PREFIXES = new Set(['posts', 'statuses', 'avatars', 'covers', 'chat-media', 'comment-media']);
const VIDEO_MIN = 3 * 1024 * 1024;
const IMAGE_MIN = 800 * 1024;

interface PrefixStat { count: number; bytes: number }
interface ObjInfo { key: string; size: number; lastModified: string | null }

export async function getMediaCensusHandler(_req: Request, res: Response, next: NextFunction) {
  try {
    const byPrefix: Record<string, PrefixStat> = {};
    const largest: ObjInfo[] = [];
    let totalCount = 0;
    let totalBytes = 0;
    let oldVideoCount = 0;
    let oldVideoBytes = 0;
    let oldImageCount = 0;
    let oldImageBytes = 0;
    let token: string | undefined;

    do {
      const out = await r2Client.send(
        new ListObjectsV2Command({ Bucket: env.r2BucketName, ContinuationToken: token, MaxKeys: 1000 }),
      );
      for (const obj of out.Contents ?? []) {
        const key = obj.Key ?? '';
        if (!key) continue;
        const size = obj.Size ?? 0;
        const prefix = key.includes('/') ? key.slice(0, key.indexOf('/')) : '(root)';
        const stat = (byPrefix[prefix] ??= { count: 0, bytes: 0 });
        stat.count += 1;
        stat.bytes += size;
        totalCount += 1;
        totalBytes += size;

        const modified = obj.LastModified ?? null;
        if (modified && modified < OLD_CUTOFF) {
          if (prefix === VIDEO_PREFIX && size >= VIDEO_MIN) {
            oldVideoCount += 1;
            oldVideoBytes += size;
          } else if (IMAGE_PREFIXES.has(prefix) && size >= IMAGE_MIN) {
            oldImageCount += 1;
            oldImageBytes += size;
          }
        }

        largest.push({ key, size, lastModified: modified ? modified.toISOString() : null });
        if (largest.length > 60) {
          largest.sort((a, b) => b.size - a.size);
          largest.length = 30;
        }
      }
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);

    largest.sort((a, b) => b.size - a.size);

    sendSuccess(res, {
      totalCount,
      totalBytes,
      byPrefix,
      largest: largest.slice(0, 30),
      oldCandidates: {
        cutoff: OLD_CUTOFF.toISOString(),
        videos: { count: oldVideoCount, bytes: oldVideoBytes, minBytes: VIDEO_MIN },
        images: { count: oldImageCount, bytes: oldImageBytes, minBytes: IMAGE_MIN },
      },
    });
  } catch (err) {
    next(err);
  }
}
