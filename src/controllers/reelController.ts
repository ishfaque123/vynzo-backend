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
import { createWatermarkedReelDownload } from '../services/reelDownloadService';
import { createTrimmedReel } from '../services/reelTrimService';
import { extractVideoFrameToR2 } from '../services/videoThumbnailService';

export async function getReelsConfigHandler(req: Request, res: Response, next: NextFunction) { try { sendSuccess(res, await getReelsConfig()); } catch (err) { next(err); } }
const createReelSchema = z.object({ caption: z.string().max(500).optional(), durationSec: z.coerce.number().int().positive(), trimStartSec: z.coerce.number().min(0).optional(), trimEndSec: z.coerce.number().positive().optional(), filter: z.enum(['normal', 'warm', 'cool', 'bw', 'vintage', 'vivid', 'beauty']).optional(), textOverlay: z.string().max(100).optional(), textPosition: z.enum(['top', 'middle', 'bottom']).optional(), speed: z.enum(['0.5', '1', '1.5', '2']).optional(), letterbox: z.string().optional(), flip: z.string().optional(), rotate: z.string().optional() });
export async function createReelHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const files = req.files as { video?: Express.Multer.File[]; cover?: Express.Multer.File[] } | undefined;
    const videoFile = files?.video?.[0];
    const coverFile = files?.cover?.[0];
    if (!videoFile) throw new ApiError(400, 'NO_VIDEO', 'Please select a video to upload.');
    if (coverFile && coverFile.size > 10 * 1024 * 1024) throw new ApiError(400, 'COVER_TOO_LARGE', 'Cover image must be smaller than 10MB.');
    const { caption, durationSec, trimStartSec = 0, trimEndSec, filter, textOverlay, textPosition, speed, letterbox, flip, rotate } = createReelSchema.parse(req.body);
    if (durationSec > env.reelMaxDurationSec) throw new ApiError(400, 'INVALID_DURATION', `Reel duration must be between 1 and ${env.reelMaxDurationSec} seconds.`);
    if (trimEndSec != null && trimEndSec <= trimStartSec) throw new ApiError(400, 'INVALID_TRIM', 'Trim end must be after trim start.');
    if (trimEndSec != null && trimEndSec - trimStartSec < 1) throw new ApiError(400, 'INVALID_TRIM', 'Trimmed reel must be at least 1 second long.');
    const videoFilter = filter && filter !== 'normal' ? filter : undefined;
    const overlayText = typeof textOverlay === 'string' ? textOverlay.trim().slice(0, 100) : '';
    const playbackSpeed = speed && speed !== '1' ? speed : undefined;
    const useLetterbox = letterbox === 'true';
    const useFlip = flip === 'true';
    const rotateDeg = rotate === '90' ? 90 : rotate === '180' ? 180 : rotate === '270' ? 270 : 0;
    const needsProcessing = trimEndSec != null || videoFilter || overlayText || playbackSpeed || useLetterbox || useFlip || rotateDeg !== 0;
    const tempPath = videoFile.path;
    const coverTempPath = coverFile?.path;
    let videoUrl: string | undefined;
    let thumbnailUrl: string | undefined;
    try {
      if (coverFile && coverTempPath) {
        thumbnailUrl = await uploadStreamToR2(createReadStream(coverTempPath), coverFile.mimetype, 'reel-covers', 'jpg');
      } else {
        // No cover selected: auto-generate thumbnail from a video frame
        // (Instagram/FB pattern). Seek to trimStart so the frame matches
        // the trimmed output.
        try {
          thumbnailUrl = await extractVideoFrameToR2(tempPath, trimStartSec + 0.5, 'reel-covers');
        } catch (err) {
          console.error('[reel] auto thumbnail extraction failed', err);
        }
      }
      if (needsProcessing) {
        const originalUrl = await uploadStreamToR2(createReadStream(tempPath), videoFile.mimetype, 'reels', path.extname(videoFile.originalname).slice(1).toLowerCase() || 'mp4');
        try {
          videoUrl = await createTrimmedReel(originalUrl, trimStartSec, trimEndSec ?? 0, videoFilter, { filter: videoFilter, textOverlay: overlayText || undefined, textPosition: textPosition || 'top', speed: playbackSpeed, letterbox: useLetterbox, flip: useFlip, rotate: rotateDeg });
          await deleteFromR2(originalUrl).catch(() => {});
        } catch (err) {
          await deleteFromR2(originalUrl).catch(() => {});
          throw err;
        }
      } else {
        videoUrl = await uploadStreamToR2(createReadStream(tempPath), videoFile.mimetype, 'reels', path.extname(videoFile.originalname).slice(1).toLowerCase() || 'mp4');
      }
      sendSuccess(res, { reel: await createReel(req.user!.id, { videoUrl, caption, durationSec, thumbnailUrl }) }, 201);
    } catch (err) {
      if (videoUrl) await deleteFromR2(videoUrl).catch(() => {});
      if (thumbnailUrl) await deleteFromR2(thumbnailUrl).catch(() => {});
      throw err;
    } finally {
      await unlink(tempPath).catch(() => {});
      if (coverTempPath) await unlink(coverTempPath).catch(() => {});
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
export async function downloadReelHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const reel = await getReelById(req.params.id, req.user!.id);
    const username = reel.author.username || 'user';
    const video = await createWatermarkedReelDownload(reel.videoUrl, username);
    res.status(200);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', String(video.length));
    res.setHeader('Content-Disposition', `attachment; filename="frianzo-reel-${reel.id}.mp4"`);
    res.send(video);
  } catch (err) {
    next(err);
  }
}

export async function recordReelViewHandler(req: Request, res: Response, next: NextFunction) { try { sendSuccess(res, await recordReelView(req.user!.id, req.params.id)); } catch (err) { next(err); } }
