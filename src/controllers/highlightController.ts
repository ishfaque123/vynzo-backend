import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../utils/ApiResponse';
import {
  getUserHighlights, createHighlight, deleteHighlight, addToHighlight, removeFromHighlight,
} from '../services/highlightService';
import { z } from 'zod';

export async function getHighlightsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const highlights = await getUserHighlights(req.params.username);
    sendSuccess(res, { highlights });
  } catch (err) { next(err); }
}

const createSchema = z.object({
  title: z.string().min(1).max(30),
  statusIds: z.array(z.string()).min(1).max(20),
});

export async function createHighlightHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const data = createSchema.parse(req.body);
    const highlight = await createHighlight(req.user!.id, data.title, data.statusIds);
    sendSuccess(res, { highlight });
  } catch (err) { next(err); }
}

export async function deleteHighlightHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await deleteHighlight(req.user!.id, req.params.id);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

const addSchema = z.object({
  statusIds: z.array(z.string()).min(1).max(20),
});

export async function addToHighlightHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const data = addSchema.parse(req.body);
    const highlight = await addToHighlight(req.user!.id, req.params.id, data.statusIds);
    sendSuccess(res, { highlight });
  } catch (err) { next(err); }
}

export async function removeFromHighlightHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await removeFromHighlight(req.user!.id, req.params.id, req.params.itemId);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}
