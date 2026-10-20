import { Request, Response, NextFunction } from 'express';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { mkdtemp, rm, stat, writeFile } from 'fs/promises';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { tmpdir } from 'os';
import { join } from 'path';
import { r2Client, uploadBufferToKey, uploadFileToKey } from '../config/r2';
import { env } from '../config/env';
import { ApiError } from '../middleware/errorHandler';
import { sendSuccess } from '../utils/ApiResponse';
import { compressVideoForUpload } from '../services/reelTrimService';
import { compressImageBuffer } from '../services/imageCompressService';
import { getVideoDurationSec } from '../services/videoThumbnailService';

// ONE-FILE media optimizer (added 2026-10-20, owner-ordered test-first):
// re-encodes ONE stored object with the exact recipes new uploads use and
// overwrites it at the SAME key (same public URL) — but only when the result
// is verified smaller and playable. The original is never touched until a
// smaller, verified replacement exists, and nothing is ever deleted.
// Temporary maintenance tool behind admin auth; remove after the batch run.
const ALLOWED_PREFIXES = new Set([
  'reels', 'statuses', 'posts', 'avatars', 'covers', 'chat-media', 'comment-media',
]);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'webm', 'mkv']);
const IMAGE_MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
};

export async function optimizeOneMediaHandler(req: Request, res: Response, next: NextFunction) {
  let dir: string | null = null;
  try {
    const key = String(req.query.key ?? '');
    if (!/^[a-z-]+\/[A-Za-z0-9._-]+$/.test(key) || key.includes('..')) {
      throw new ApiError(400, 'BAD_KEY', 'Invalid object key.');
    }
    const prefix = key.slice(0, key.indexOf('/'));
    const ext = key.split('.').pop()?.toLowerCase() ?? '';
    if (!ALLOWED_PREFIXES.has(prefix)) {
      throw new ApiError(400, 'BAD_PREFIX', 'Folder not allowed for optimization.');
    }
    const isVideo = VIDEO_EXTS.has(ext);
    const imageMime = IMAGE_MIME[ext];
    if (!isVideo && !imageMime) {
      throw new ApiError(400, 'BAD_TYPE', 'Only video and image files can be optimized.');
    }

    const obj = await r2Client.send(new GetObjectCommand({ Bucket: env.r2BucketName, Key: key }));
    if (!obj.Body) throw new ApiError(404, 'NOT_FOUND', 'Object not found.');
    const before = obj.ContentLength ?? 0;

    dir = await mkdtemp(join(tmpdir(), 'fri-opt-'));

    if (isVideo) {
      const inPath = join(dir, `in.${ext}`);
      await pipeline(obj.Body as Readable, createWriteStream(inPath));
      const outPath = await compressVideoForUpload(inPath);
      if (outPath === inPath) {
        return sendSuccess(res, { key, before, after: before, replaced: false, reason: 'not_smaller' });
      }
      const duration = await getVideoDurationSec(outPath);
      if (!duration || duration <= 0) {
        return sendSuccess(res, { key, before, after: before, replaced: false, reason: 'verify_failed' });
      }
      const outStats = await stat(outPath);
      await uploadFileToKey(outPath, key, 'video/mp4');
      return sendSuccess(res, {
        key, before, after: outStats.size, replaced: true,
        savedBytes: before - outStats.size,
        savedPct: Math.round((1 - outStats.size / before) * 100),
        durationSec: Math.round(duration),
      });
    }

    const bytes = await obj.Body.transformToByteArray();
    const original = Buffer.from(bytes);
    const result = await compressImageBuffer(original, imageMime);
    if (result.buffer.length >= original.length) {
      return sendSuccess(res, { key, before, after: before, replaced: false, reason: 'not_smaller' });
    }
    await writeFile(join(dir, 'check.jpg'), result.buffer);
    await uploadBufferToKey(result.buffer, key, result.mimeType);
    return sendSuccess(res, {
      key, before, after: result.buffer.length, replaced: true,
      savedBytes: before - result.buffer.length,
      savedPct: Math.round((1 - result.buffer.length / before) * 100),
    });
  } catch (err) {
    next(err);
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
