import { Request, Response, NextFunction } from 'express';
import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
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

// Media optimizer (added 2026-10-20, owner-ordered: test one file first,
// then the full batch after the test passed with 96% saved and quality
// verified frame-by-frame). Re-encodes stored objects with the exact
// recipes new uploads use and overwrites each at the SAME key (same public
// URL) — only when the result is verified smaller and playable. The
// original is never touched until a smaller, verified replacement exists,
// and nothing is ever deleted. Temporary maintenance tool behind admin
// auth; remove after the batch run completes.
const ALLOWED_PREFIXES = new Set([
  'reels', 'statuses', 'posts', 'avatars', 'covers', 'chat-media', 'comment-media',
]);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'webm', 'mkv']);
const IMAGE_MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
};
const OLD_CUTOFF = new Date('2026-10-20T00:00:00.000Z');
const VIDEO_MIN = 3 * 1024 * 1024;
const IMAGE_MIN = 800 * 1024;

interface OptimizeResult {
  key: string;
  before: number;
  after: number;
  replaced: boolean;
  reason?: string;
  savedBytes?: number;
  savedPct?: number;
  durationSec?: number;
  error?: string;
}

function parseKey(key: string): { prefix: string; ext: string; isVideo: boolean; imageMime?: string } {
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
  return { prefix, ext, isVideo, imageMime };
}

async function optimizeStoredObject(key: string): Promise<OptimizeResult> {
  const { ext, isVideo, imageMime } = parseKey(key);
  let dir: string | null = null;
  try {
    const obj = await r2Client.send(new GetObjectCommand({ Bucket: env.r2BucketName, Key: key }));
    if (!obj.Body) throw new ApiError(404, 'NOT_FOUND', 'Object not found.');
    const before = obj.ContentLength ?? 0;
    dir = await mkdtemp(join(tmpdir(), 'fri-opt-'));

    if (isVideo) {
      const inPath = join(dir, `in.${ext}`);
      await pipeline(obj.Body as Readable, createWriteStream(inPath));
      const outPath = await compressVideoForUpload(inPath);
      if (outPath === inPath) {
        return { key, before, after: before, replaced: false, reason: 'not_smaller' };
      }
      const duration = await getVideoDurationSec(outPath);
      if (!duration || duration <= 0) {
        return { key, before, after: before, replaced: false, reason: 'verify_failed' };
      }
      const outStats = await stat(outPath);
      await uploadFileToKey(outPath, key, 'video/mp4');
      return {
        key, before, after: outStats.size, replaced: true,
        savedBytes: before - outStats.size,
        savedPct: Math.round((1 - outStats.size / before) * 100),
        durationSec: Math.round(duration),
      };
    }

    const bytes = await obj.Body.transformToByteArray();
    const original = Buffer.from(bytes);
    const result = await compressImageBuffer(original, imageMime!);
    if (result.buffer.length >= original.length) {
      return { key, before, after: before, replaced: false, reason: 'not_smaller' };
    }
    await uploadBufferToKey(result.buffer, key, result.mimeType);
    return {
      key, before, after: result.buffer.length, replaced: true,
      savedBytes: before - result.buffer.length,
      savedPct: Math.round((1 - result.buffer.length / before) * 100),
    };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function optimizeOneMediaHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const key = String(req.query.key ?? '');
    sendSuccess(res, await optimizeStoredObject(key));
  } catch (err) {
    next(err);
  }
}

// ---- Batch mode ------------------------------------------------------------
// Candidates are the pre-compression-era objects (same rules as the media
// census). Processed objects drop out of the candidate set on their own:
// overwriting updates LastModified to "now", past the cutoff. The loop runs
// in-process, one file at a time with a pause between files, and stops by
// itself after 3 consecutive failures. State is in-memory (a server restart
// simply means "start again" — already-done files are never re-processed).
interface BatchState {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  planned: number;
  processed: number;
  replacedCount: number;
  failed: number;
  savedBytes: number;
  currentKey: string | null;
  stoppedReason: string | null;
  lastResults: OptimizeResult[];
}

const batchState: BatchState = {
  running: false, startedAt: null, finishedAt: null, planned: 0,
  processed: 0, replacedCount: 0, failed: 0, savedBytes: 0,
  currentKey: null, stoppedReason: null, lastResults: [],
};

async function listCandidates(): Promise<{ key: string; size: number }[]> {
  const out: { key: string; size: number }[] = [];
  let token: string | undefined;
  do {
    const page = await r2Client.send(
      new ListObjectsV2Command({ Bucket: env.r2BucketName, ContinuationToken: token, MaxKeys: 1000 }),
    );
    for (const obj of page.Contents ?? []) {
      const key = obj.Key ?? '';
      const size = obj.Size ?? 0;
      const modified = obj.LastModified ?? null;
      if (!key || !modified || modified >= OLD_CUTOFF) continue;
      const slash = key.indexOf('/');
      if (slash < 0) continue;
      const prefix = key.slice(0, slash);
      if (!ALLOWED_PREFIXES.has(prefix)) continue;
      const ext = key.split('.').pop()?.toLowerCase() ?? '';
      if (VIDEO_EXTS.has(ext) && size >= VIDEO_MIN) out.push({ key, size });
      else if (IMAGE_MIME[ext] && size >= IMAGE_MIN) out.push({ key, size });
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  out.sort((a, b) => b.size - a.size);
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runBatch(limit: number) {
  try {
    const candidates = await listCandidates();
    const slice = candidates.slice(0, limit);
    batchState.planned = slice.length;
    let consecutiveFailures = 0;
    for (const { key } of slice) {
      batchState.currentKey = key;
      try {
        const result = await optimizeStoredObject(key);
        batchState.processed += 1;
        if (result.replaced) {
          batchState.replacedCount += 1;
          batchState.savedBytes += result.savedBytes ?? 0;
        }
        batchState.lastResults = [result, ...batchState.lastResults].slice(0, 12);
        consecutiveFailures = 0;
      } catch (err) {
        batchState.processed += 1;
        batchState.failed += 1;
        consecutiveFailures += 1;
        batchState.lastResults = [{
          key, before: 0, after: 0, replaced: false,
          error: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
        }, ...batchState.lastResults].slice(0, 12);
        if (consecutiveFailures >= 3) {
          batchState.stoppedReason = 'three_consecutive_failures';
          break;
        }
      }
      await sleep(500);
    }
  } catch (err) {
    batchState.stoppedReason = err instanceof Error ? err.message.slice(0, 200) : 'batch_error';
  } finally {
    batchState.running = false;
    batchState.currentKey = null;
    batchState.finishedAt = new Date().toISOString();
  }
}

export async function optimizeBatchStartHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (batchState.running) {
      return sendSuccess(res, { alreadyRunning: true, ...batchState });
    }
    const raw = parseInt(String(req.query.limit ?? '30'), 10);
    const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 60) : 30;
    batchState.running = true;
    batchState.startedAt = new Date().toISOString();
    batchState.finishedAt = null;
    batchState.planned = 0;
    batchState.processed = 0;
    batchState.replacedCount = 0;
    batchState.failed = 0;
    batchState.savedBytes = 0;
    batchState.currentKey = null;
    batchState.stoppedReason = null;
    batchState.lastResults = [];
    void runBatch(limit);
    sendSuccess(res, { started: true, limit, ...batchState });
  } catch (err) {
    next(err);
  }
}

export async function optimizeBatchStatusHandler(_req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, { ...batchState });
  } catch (err) {
    next(err);
  }
}
