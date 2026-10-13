import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../utils/ApiResponse';
import { getTagContent } from '../services/tagService';

export async function getTagHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const tag = req.params.tag as string;
    const limit = parseInt(req.query.limit as string, 10) || 20;
    const offset = parseInt(req.query.offset as string, 10) || 0;
    const data = await getTagContent(tag, req.user?.id, limit, offset);
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}
