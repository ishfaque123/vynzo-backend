import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../utils/ApiResponse';
import { toggleFollow, getFollowCounts, getFriendStatus, getFollowUsers } from '../services/followService';

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

export async function getFollowStatusHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const status = await getFriendStatus(req.user?.id, req.params.userId);
    sendSuccess(res, { status });
  } catch (err) {
    next(err);
  }
}

export async function getFollowUsersHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const direction = req.params.direction as 'followers' | 'following';
    const page = Number(req.query.page ?? 1);
    const limit = Number(req.query.limit ?? 20);
    const result = await getFollowUsers(req.params.userId, direction, page, limit, req.user?.id);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}
