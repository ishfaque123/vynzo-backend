import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../utils/ApiResponse';
import { searchContent } from '../services/searchService';

// v5.18 (staged, NOT deployed): GET /api/search?q=&type=posts|reels|all&limit=&offset=
// type defaults to "all"; unknown types fall back to "all".
export async function searchHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const q = (req.query.q as string) || '';
    const rawType = (req.query.type as string) || 'all';
    const type = rawType === 'posts' || rawType === 'reels' ? rawType : 'all';
    const limit = parseInt(req.query.limit as string, 10) || 20;
    const offset = parseInt(req.query.offset as string, 10) || 0;
    const data = await searchContent(q, req.user?.id, type, limit, offset);
    sendSuccess(res, data);
  } catch (err) {
    next(err);
  }
}
