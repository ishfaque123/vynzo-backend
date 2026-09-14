import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../utils/ApiResponse';
import { ApiError } from '../middleware/errorHandler';
import {
  createReel,
  getReelFeed,
  toggleReelLike,
  toggleReelFavorite,
  getMyFavoriteReels,
  deleteReel,
  getReelsConfig,
  getMyDailyReelStatus,
  addReelComment,
  getReelComments,
  deleteReelComment,
} from '../services/reelService';
import { uploadToR2, deleteFromR2 } from '../config/r2';
import { z } from 'zod';

export async function getReelsConfigHandler(req: Request, res: Response, next: NextFunction) {
  try { sendSuccess(res, await getReelsConfig()); } catch (err) { next(err); }
}

const createReelSchema = z.object({
  caption: z.string().max(500).optional(),
  durationSec: z.coerce.number().int().positive().max(60),
});

export async function createReelHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.file) throw new ApiError(400, 'NO_VIDEO', 'Please select a video to upload.');
    const { caption, durationSec } = createReelSchema.parse(req.body);
    const videoUrl = await uploadToR2(req.file.buffer, req.file.mimetype, 'reels');

    try {
      const reel = await createReel(req.user!.id, { videoUrl, caption, durationSec });
      sendSuccess(res, { reel }, 201);
    } catch (err) {
      // Do not leave an R2 orphan when DB validation/limits reject the reel.
      await deleteFromR2(videoUrl).catch(() => {});
      throw err;
    }
  } catch (err) { next(err); }
}

export async function getReelFeedHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const rawOffset = parseInt(String(req.query.offset ?? '0'), 10);
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;
    sendSuccess(res, await getReelFeed(req.user!.id, 10, offset));
  } catch (err) { next(err); }
}

export async function toggleReelLikeHandler(req: Request, res: Response, next: NextFunction) {
  try { sendSuccess(res, await toggleReelLike(req.user!.id, req.params.id)); } catch (err) { next(err); }
}

export async function toggleReelFavoriteHandler(req: Request, res: Response, next: NextFunction) {
  try { sendSuccess(res, await toggleReelFavorite(req.user!.id, req.params.id)); } catch (err) { next(err); }
}

export async function getMyFavoriteReelsHandler(req: Request, res: Response, next: NextFunction) {
  try { sendSuccess(res, { reels: await getMyFavoriteReels(req.user!.id) }); } catch (err) { next(err); }
}

export async function deleteReelHandler(req: Request, res: Response, next: NextFunction) {
  try { sendSuccess(res, await deleteReel(req.user!.id, req.params.id)); } catch (err) { next(err); }
}

export async function getMyReelStatusHandler(req: Request, res: Response, next: NextFunction) {
  try { sendSuccess(res, await getMyDailyReelStatus(req.user!.id)); } catch (err) { next(err); }
}

export async function addReelCommentHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    sendSuccess(res, { comment: await addReelComment(req.user!.id, req.params.id, content) }, 201);
  } catch (err) { next(err); }
}

export async function getReelCommentsHandler(req: Request, res: Response, next: NextFunction) {
  try { sendSuccess(res, { comments: await getReelComments(req.params.id) }); } catch (err) { next(err); }
}

export async function deleteReelCommentHandler(req: Request, res: Response, next: NextFunction) {
  try { sendSuccess(res, await deleteReelComment(req.user!.id, req.params.commentId)); } catch (err) { next(err); }
}
