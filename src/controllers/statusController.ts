import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../utils/ApiResponse';
import { createStatus, getStatusFeed, viewStatus, getStatusViewers, deleteStatus, toggleStatusLike } from '../services/statusService';
import { uploadToR2 } from '../config/r2';
import { extractVideoFrameToR2 } from '../services/videoThumbnailService';
import { writeFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { z } from 'zod';

const createStatusSchema = z.object({ textContent: z.string().max(500).optional(), bgColor: z.string().max(20).optional(), visibility: z.enum(['everyone', 'close_friends']).optional() });

export async function createStatusHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { textContent, bgColor, visibility } = createStatusSchema.parse(req.body);
    let mediaUrl: string | undefined;
    let mediaType: string | undefined;
    let thumbnailUrl: string | undefined;
    if (req.file) {
      mediaUrl = await uploadToR2(req.file.buffer, req.file.mimetype, 'statuses');
      mediaType = req.file.mimetype.startsWith('video') ? 'video' : 'image';
      if (mediaType === 'video') {
        // Auto-generate thumbnail from a video frame (Instagram/FB pattern) —
        // clients always get a poster, never a bare <video> placeholder.
        const tmpPath = path.join(os.tmpdir(), `frianzo-status-${Date.now()}.mp4`);
        try {
          await writeFile(tmpPath, req.file.buffer);
          thumbnailUrl = await extractVideoFrameToR2(tmpPath, 0.5, 'status-thumbnails');
        } catch (err) {
          console.error('[status] thumbnail extraction failed', err);
        } finally {
          await rm(tmpPath, { force: true }).catch(() => {});
        }
      }
    }
    const status = await createStatus(req.user!.id, { mediaUrl, mediaType, thumbnailUrl, textContent, bgColor, visibility });
    sendSuccess(res, { status }, 201);
  } catch (err) { next(err); }
}
export async function getStatusFeedHandler(req: Request, res: Response, next: NextFunction) {
  try { sendSuccess(res, { feed: await getStatusFeed(req.user!.id) }); } catch (err) { next(err); }
}
export async function viewStatusHandler(req: Request, res: Response, next: NextFunction) {
  try { sendSuccess(res, await viewStatus(req.user!.id, req.params.id)); } catch (err) { next(err); }
}
export async function getStatusViewersHandler(req: Request, res: Response, next: NextFunction) {
  try { sendSuccess(res, { viewers: await getStatusViewers(req.user!.id, req.params.id) }); } catch (err) { next(err); }
}
export async function deleteStatusHandler(req: Request, res: Response, next: NextFunction) {
  try { sendSuccess(res, await deleteStatus(req.user!.id, req.params.id)); } catch (err) { next(err); }
}

export async function toggleStatusLikeHandler(req: Request, res: Response, next: NextFunction) {
  try { sendSuccess(res, await toggleStatusLike(req.user!.id, req.params.id)); } catch (err) { next(err); }
}
