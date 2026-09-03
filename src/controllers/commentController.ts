import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../utils/ApiResponse';
import { addComment, getComments } from '../services/commentService';
import { z } from 'zod';

const commentSchema = z.object({
  content: z.string().min(1).max(500),
});

export async function addCommentHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { content } = commentSchema.parse(req.body);
    const comment = await addComment(req.user!.id, req.params.postId, content);
    sendSuccess(res, { comment }, 201);
  } catch (err) {
    next(err);
  }
}

export async function getCommentsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const comments = await getComments(req.params.postId);
    sendSuccess(res, { comments });
  } catch (err) {
    next(err);
  }
}
