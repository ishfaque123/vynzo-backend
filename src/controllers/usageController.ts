import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../utils/ApiResponse';
import { recordPing, getPings } from '../services/usageService';

export async function pingHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await recordPing(req.user!.id);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}

export async function getPingsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const from = req.query.from ? new Date(String(req.query.from)) : new Date(0);
    const to = req.query.to ? new Date(String(req.query.to)) : new Date();
    const pings = await getPings(req.user!.id, from, to);
    sendSuccess(res, { pings });
  } catch (err) {
    next(err);
  }
}
