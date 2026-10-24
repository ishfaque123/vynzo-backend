import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../utils/ApiResponse';
import { ApiError } from '../middleware/errorHandler';
import { createStatus, getStatusFeed, viewStatus, getStatusViewers, deleteStatus, toggleStatusLike } from '../services/statusService';
import { votePoll, answerQuestion } from '../services/stickerService';
import { muteStories, unmuteStories, getMutedStories } from '../services/statusMuteService';
import { uploadStreamToR2, deleteFromR2 } from '../config/r2';
import { compressImageFile } from '../services/imageCompressService';
import { extractVideoFrameToR2, getVideoDurationSec } from '../services/videoThumbnailService';
import { createReadStream } from 'fs';
import { rm } from 'fs/promises';
import { z } from 'zod';

const stickerSchema = z.object({
  type: z.string(),
  posX: z.number().optional(),
  posY: z.number().optional(),
  data: z.record(z.any()),
});
const createStatusSchema = z.object({ textContent: z.string().max(500).optional(), bgColor: z.string().max(20).optional(), visibility: z.enum(['everyone', 'close_friends']).optional(), stickers: z.array(stickerSchema).max(5).optional() });

export async function createStatusHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = createStatusSchema.parse({
      textContent: req.body.textContent,
      bgColor: req.body.bgColor,
      visibility: req.body.visibility,
      stickers: req.body.stickers ? JSON.parse(String(req.body.stickers)) : undefined,
    });
    const { textContent, bgColor, visibility, stickers } = parsed;
    let mediaUrl: string | undefined;
    let mediaType: string | undefined;
    let thumbnailUrl: string | undefined;
    if (req.file) {
      // The upload now lives on disk (see statusUpload): compress and
      // stream it from the file instead of holding the whole file in RAM.
      const uploadedPath = req.file.path;
      try {
        const statusImg = await compressImageFile(uploadedPath, req.file.mimetype);
        try {
          const ext = (statusImg.mimeType.split('/')[1] || 'jpg').split(';')[0];
          mediaUrl = await uploadStreamToR2(createReadStream(statusImg.filePath), statusImg.mimeType, 'statuses', ext);
        } finally {
          await statusImg.cleanup();
        }
        mediaType = req.file.mimetype.startsWith('video') ? 'video' : 'image';
        if (mediaType === 'video') {
          // Server-side duration check (client also checks, but never trust it alone).
          // Auto-generate thumbnail from a video frame (Instagram/FB pattern) —
          // clients always get a poster, never a bare <video> placeholder.
          // The file is already on disk, so probe it in place (no copy).
          try {
            const durationSec = await getVideoDurationSec(uploadedPath);
            if (durationSec !== null && durationSec > 60) {
              // Clean up the already-uploaded media before rejecting.
              if (mediaUrl) await deleteFromR2(mediaUrl).catch(() => {});
              throw new ApiError(400, 'VIDEO_TOO_LONG', 'Status videos must be 60 seconds or shorter.');
            }
            thumbnailUrl = await extractVideoFrameToR2(uploadedPath, 0.5, 'status-thumbnails');
          } catch (err) {
            if (err instanceof ApiError) throw err;
            console.error('[status] thumbnail extraction failed', err);
          }
        }
      } finally {
        await rm(uploadedPath, { force: true }).catch(() => {});
      }
    }
    const status = await createStatus(req.user!.id, { mediaUrl, mediaType, thumbnailUrl, textContent, bgColor, visibility, stickers });
    sendSuccess(res, { status }, 201);
  } catch (err) { next(err); }
}

const voteSchema = z.object({ optionIndex: z.number().int().min(0).max(3) });
export async function votePollHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { optionIndex } = voteSchema.parse(req.body);
    sendSuccess(res, await votePoll(req.user!.id, req.params.stickerId, optionIndex));
  } catch (err) { next(err); }
}

const answerSchema = z.object({ text: z.string().min(1).max(300) });
export async function answerQuestionHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { text } = answerSchema.parse(req.body);
    sendSuccess(res, await answerQuestion(req.user!.id, req.params.stickerId, text));
  } catch (err) { next(err); }
}

export async function muteStoriesHandler(req: Request, res: Response, next: NextFunction) {
  try { sendSuccess(res, await muteStories(req.user!.id, req.params.userId)); } catch (err) { next(err); }
}
export async function unmuteStoriesHandler(req: Request, res: Response, next: NextFunction) {
  try { sendSuccess(res, await unmuteStories(req.user!.id, req.params.userId)); } catch (err) { next(err); }
}
export async function getMutedStoriesHandler(req: Request, res: Response, next: NextFunction) {
  try { sendSuccess(res, { muted: await getMutedStories(req.user!.id) }); } catch (err) { next(err); }
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
