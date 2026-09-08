import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../utils/ApiResponse';
import { createShareLink, resolveShareLink } from '../services/shareService';
import { ApiError } from '../middleware/errorHandler';

export async function createShareLinkHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { type, id } = req.body as { type?: string; id?: string };
    if (type !== 'profile' && type !== 'post') throw new ApiError(400, 'INVALID_TYPE', 'type must be "profile" or "post".');
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
