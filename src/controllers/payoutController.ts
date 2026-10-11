import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../utils/ApiResponse';
import {
  getPayoutMethods, addPayoutMethod, deletePayoutMethod, setDefaultPayoutMethod, getEarnings,
} from '../services/payoutService';
import { z } from 'zod';

export async function getPayoutMethodsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await getPayoutMethods(req.user!.id);
    sendSuccess(res, data);
  } catch (err) { next(err); }
}

const addSchema = z.object({
  methodType: z.string().min(1).max(20),
  accountName: z.string().min(1).max(100),
  accountNumber: z.string().min(1).max(50),
  extra: z.string().max(500).optional(),
});

export async function addPayoutMethodHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const data = addSchema.parse(req.body);
    const method = await addPayoutMethod(req.user!.id, data);
    sendSuccess(res, { method });
  } catch (err) { next(err); }
}

export async function deletePayoutMethodHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await deletePayoutMethod(req.user!.id, req.params.id);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function setDefaultPayoutMethodHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await setDefaultPayoutMethod(req.user!.id, req.params.id);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function getEarningsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const limit = parseInt(req.query.limit as string, 10) || 20;
    const data = await getEarnings(req.user!.id, limit);
    sendSuccess(res, data);
  } catch (err) { next(err); }
}
