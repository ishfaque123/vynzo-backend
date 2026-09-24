import { Request, Response, NextFunction } from 'express';
import { createReadStream } from 'fs';
import { unlink } from 'fs/promises';
import path from 'path';
import { sendSuccess } from '../utils/ApiResponse';
import { ApiError } from '../middleware/errorHandler';
import { createReel, getReelFeed, toggleReelLike, toggleReelFavorite, getMyFavoriteReels, deleteReel, getReelsConfig, getMyDailyReelStatus, addReelComment, getReelComments, toggleReelCommentReaction, deleteReelComment, getReelsByUsername, getReelById } from '../services/reelService';
import { editReelComment } from '../services/reelCommentEditService';
import { reportReelComment } from '../services/reelCommentReportService';
import { reportReel, recordReelView } from '../services/reelAnalyticsService';
import { uploadStreamToR2, deleteFromR2 } from '../config/r2';
import { z } from 'zod';
import { env } from '../config/env';

export async function getReelsConfigHandler(req: Request, res: Response, next: NextFunction) { try { sendSuccess(res, await getReelsConfig()); } catch (err) { next(err); } }
const createReelSchema = z.object({ caption: z.string().max(500).optional(), durationSec: z.coerce.number().int().positive() });
export async function createReelHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.file) throw new ApiError(400, 'NO_VIDEO', 'Please select a video to upload.');
    const { caption, durationSec } = createReelSchema.parse(req.body);
    if (durationSec > env.reelMaxDurationSec) throw new ApiError(400, 'INVALID_DURATION', `Reel duration must be between 1 and ${env.reelMaxDurationSec} seconds.`);
    const tempPath = req.file.path;
    let videoUrl: string | undefined;
    try {
      videoUrl = await uploadStreamToR2(
        createReadStream(tempPath),
        req.file.mimetype,
        'reels',
        path.extname(req.file.originalname).slice(1).toLowerCase() || 'mp4'
      );
      sendSuccess(res, { reel: await createReel(req.user!.id, { videoUrl, caption, durationSec }) }, 201);
    } catch (err) {
      if (videoUrl) await deleteFromR2(videoUrl).catch(() => {});
      throw err;
    } finally {
      await unlink(tempPath).catch(() => {});
    }
  } catch (err) { next(err); }
}
export async function getReelFeedHandler(req: Request, res: Response, next: NextFunction) { try { const rawOffset = parseInt(String(req.query.offset ?? '0'), 10); const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0; sendSuccess(res, await getReelFeed(req.user!.id, 10, offset)); } catch (err) { next(err); } }
export async function toggleReelLikeHandler(req: Request, res: Response, next: NextFunction) { try { sendSuccess(res, await toggleReelLike(req.user!.id, req.params.id)); } catch (err) { next(err); } }
export async function toggleReelFavoriteHandler(req: Request, res: Response, next: NextFunction) { try { sendSuccess(res, await toggleReelFavorite(req.user!.id, req.params.id)); } catch (err) { next(err); } }
export async function getMyFavoriteReelsHandler(req: Request, res: Response, next: NextFunction) { try { sendSuccess(res, { reels: await getMyFavoriteReels(req.user!.id) }); } catch (err) { next(err); } }
export async function getReelsByUsernameHandler(req: Request, res: Response, next: NextFunction) { try { sendSuccess(res, { reels: await getReelsByUsername(req.params.username, req.user!.id) }); } catch (err) { next(err); } }
export async function getReelByIdHandler(req: Request, res: Response, next: NextFunction) { try { sendSuccess(res, { reel: await getReelById(req.params.id, req.user!.id) }); } catch (err) { next(err); } }
export async function deleteReelHandler(req: Request, res: Response, next: NextFunction) { try { sendSuccess(res, await deleteReel(req.user!.id, req.params.id)); } catch (err) { next(err); } }
export async function getMyReelStatusHandler(req: Request, res: Response, next: NextFunction) { try { sendSuccess(res, await getMyDailyReelStatus(req.user!.id)); } catch (err) { next(err); } }
export async function addReelCommentHandler(req: Request, res: Response, next: NextFunction) { try { const content = typeof req.body?.content === 'string' ? req.body.content : ''; const parentCommentId = typeof req.body?.parentCommentId === 'string' && req.body.parentCommentId.trim() ? req.body.parentCommentId.trim() : undefined; sendSuccess(res, { comment: await addReelComment(req.user!.id, req.params.id, content, parentCommentId) }, 201); } catch (err) { next(err); } }
export async function getReelCommentsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const cursor = typeof req.query.cursor === 'string' && req.query.cursor.trim() ? req.query.cursor.trim() : undefined;
    const rawLimit = parseInt(String(req.query.limit ?? '20'), 10);
    const limit = Number.isFinite(rawLimit) ? rawLimit : 20;
    sendSuccess(res, await getReelComments(req.params.id, req.user!.id, cursor, limit));
  } catch (err) { next(err); }
}
export async function toggleReelCommentReactionHandler(req: Request, res: Response, next: NextFunction) { try { const type = typeof req.body?.type === 'string' ? req.body.type : 'like'; sendSuccess(res, await toggleReelCommentReaction(req.user!.id, req.params.commentId, type)); } catch (err) { next(err); } }
export async function editReelCommentHandler(req: Request, res: Response, next: NextFunction) { try { const content = typeof req.body?.content === 'string' ? req.body.content : ''; sendSuccess(res, { comment: await editReelComment(req.user!.id, req.params.commentId, content) }); } catch (err) { next(err); } }
export async function reportReelCommentHandler(req: Request, res: Response, next: NextFunction) { try { const reason = typeof req.body?.reason === 'string' ? req.body.reason : 'other'; const details = typeof req.body?.details === 'string' ? req.body.details : undefined; sendSuccess(res, await reportReelComment(req.user!.id, req.params.commentId, reason, details)); } catch (err) { next(err); } }
export async function deleteReelCommentHandler(req: Request, res: Response, next: NextFunction) { try { sendSuccess(res, await deleteReelComment(req.user!.id, req.params.commentId)); } catch (err) { next(err); } }
export async function reportReelHandler(req: Request, res: Response, next: NextFunction) { try { const reason = typeof req.body?.reason === 'string' ? req.body.reason : 'other'; const details = typeof req.body?.details === 'string' ? req.body.details : undefined; sendSuccess(res, await reportReel(req.user!.id, req.params.id, reason, details)); } catch (err) { next(err); } }
export async function recordReelViewHandler(req: Request, res: Response, next: NextFunction) { try { sendSuccess(res, await recordReelView(req.user!.id, req.params.id)); } catch (err) { next(err); } }
