import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../utils/ApiResponse';
import { createShareLink, resolveShareLink, recordShareEvent } from '../services/shareService';
import { ApiError } from '../middleware/errorHandler';

export async function recordShareEventHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { type, id, channel } = req.body as { type?: string; id?: string; channel?: string };
    if (type !== 'post' && type !== 'reel') throw new ApiError(400, 'INVALID_TYPE', 'type must be "post" or "reel".');
    if (!id) throw new ApiError(400, 'MISSING_ID', 'id is required.');
    if (!channel) throw new ApiError(400, 'MISSING_CHANNEL', 'channel is required.');
    await recordShareEvent(type, id, channel, (req as any).user?.id);
    sendSuccess(res, { recorded: true });
  } catch (err) {
    next(err);
  }
}

export async function createShareLinkHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { type, id } = req.body as { type?: string; id?: string };
    if (type !== 'profile' && type !== 'post' && type !== 'reel') {
      throw new ApiError(400, 'INVALID_TYPE', 'type must be "profile", "post", or "reel".');
    }
    if (!id) throw new ApiError(400, 'MISSING_ID', 'id is required.');
    const code = await createShareLink(type, id);
    sendSuccess(res, { code });
  } catch (err) {
    next(err);
  }
}

export async function getShareLinkHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await resolveShareLink(req.params.code);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}
