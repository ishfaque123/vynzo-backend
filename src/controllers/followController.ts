import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../utils/ApiResponse';
import { toggleFollow, getFollowCounts } from '../services/followService';

export async function toggleFollowHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await toggleFollow(req.user!.id, req.params.userId);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

export async function getFollowCountsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const counts = await getFollowCounts(req.params.userId);
    sendSuccess(res, counts);
  } catch (err) {
    next(err);
  }
}
