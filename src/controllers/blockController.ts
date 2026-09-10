import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../utils/ApiResponse';
import { blockUser, unblockUser, getBlockStatus } from '../services/blockService';

export async function blockUserHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await blockUser(req.user!.id, req.params.userId);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function unblockUserHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await unblockUser(req.user!.id, req.params.userId);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function getBlockStatusHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await getBlockStatus(req.user!.id, req.params.userId);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}
