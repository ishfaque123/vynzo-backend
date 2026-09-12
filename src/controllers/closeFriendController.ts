import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../utils/ApiResponse';
import { getCloseFriendCandidates, addCloseFriend, removeCloseFriend } from '../services/closeFriendService';

export async function getCloseFriendsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const candidates = await getCloseFriendCandidates(req.user!.id);
    sendSuccess(res, { users: candidates });
  } catch (err) { next(err); }
}

export async function addCloseFriendHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await addCloseFriend(req.user!.id, req.params.userId);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function removeCloseFriendHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await removeCloseFriend(req.user!.id, req.params.userId);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}
