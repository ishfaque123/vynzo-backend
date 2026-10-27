import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../utils/ApiResponse';
import {
  applyForMonetization,
  getMyMonetization,
  listMonetizationRequests,
  reviewMonetizationRequest,
} from '../services/monetizationService';
import { z } from 'zod';

export async function applyMonetizationHandler(req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, await applyForMonetization(req.user!.id));
  } catch (err) {
    next(err);
  }
}

export async function getMyMonetizationHandler(req: Request, res: Response, next: NextFunction) {
  try {
    sendSuccess(res, await getMyMonetization(req.user!.id));
  } catch (err) {
    next(err);
  }
}

export async function listMonetizationHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    sendSuccess(res, await listMonetizationRequests(status));
  } catch (err) {
    next(err);
  }
}

const reviewSchema = z.object({
  action: z.enum(['approve', 'reject']),
  adminNote: z.string().max(1000).optional(),
});

export async function reviewMonetizationHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const data = reviewSchema.parse(req.body);
    sendSuccess(
      res,
      await reviewMonetizationRequest(req.user!.id, req.params.requestId, data.action, data.adminNote),
    );
  } catch (err) {
    next(err);
  }
}
