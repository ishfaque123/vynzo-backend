import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../utils/ApiResponse';
import { createStatus, getStatusFeed, viewStatus, getStatusViewers, deleteStatus } from '../services/statusService';
import { uploadToR2 } from '../config/r2';
import { z } from 'zod';

const createStatusSchema = z.object({ textContent: z.string().max(500).optional(), bgColor: z.string().max(20).optional() });

export async function createStatusHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { textContent, bgColor } = createStatusSchema.parse(req.body);
    let mediaUrl: string | undefined;
    let mediaType: string | undefined;
    if (req.file) {
      mediaUrl = await uploadToR2(req.file.buffer, req.file.mimetype, 'statuses');
      mediaType = req.file.mimetype.startsWith('video') ? 'video' : 'image';
    }
    const status = await createStatus(req.user!.id, { mediaUrl, mediaType, textContent, bgColor });
    sendSuccess(res, { status }, 201);
  } catch (err) { next(err); }
}
export async function getStatusFeedHandler(req: Request, res: Response, next: NextFunction) {
  try { sendSuccess(res, { feed: await getStatusFeed(req.user!.id) }); } catch (err) { next(err); }
}
export async function viewStatusHandler(req: Request, res: Response, next: NextFunction) {
  try { sendSuccess(res, await viewStatus(req.user!.id, req.params.id)); } catch (err) { next(err); }
}
export async function getStatusViewersHandler(req: Request, res: Response, next: NextFunction) {
  try { sendSuccess(res, { viewers: await getStatusViewers(req.user!.id, req.params.id) }); } catch (err) { next(err); }
}
export async function deleteStatusHandler(req: Request, res: Response, next: NextFunction) {
  try { sendSuccess(res, await deleteStatus(req.user!.id, req.params.id)); } catch (err) { next(err); }
}
