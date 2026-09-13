import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../utils/ApiResponse';
import { addComment, getComments, toggleCommentsSetting, deleteComment, editComment, setCommentReaction, reportComment } from '../services/commentService';
import { z } from 'zod';

const commentSchema = z.object({
  content: z.string().min(1).max(500),
  parentCommentId: z.string().optional(),
  taggedUserIds: z.array(z.string()).optional().default([]),
});

export async function addCommentHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { content, parentCommentId, taggedUserIds } = commentSchema.parse(req.body);
    const comment = await addComment(req.user!.id, req.params.postId, content, parentCommentId, taggedUserIds);
    sendSuccess(res, { comment }, 201);
  } catch (err) { next(err); }
}

export async function getCommentsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const comments = await getComments(req.params.postId, req.user?.id);
    sendSuccess(res, { comments });
  } catch (err) { next(err); }
}

const editSchema = z.object({ content: z.string().min(1).max(500) });

export async function editCommentHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { content } = editSchema.parse(req.body);
    const comment = await editComment(req.user!.id, req.params.commentId, content);
    sendSuccess(res, { comment });
  } catch (err) { next(err); }
}

export async function deleteCommentHandler(req: Request, res: Response, next: NextFunction) {
  try {
    await deleteComment(req.user!.id, req.params.commentId);
    sendSuccess(res, { deleted: true });
  } catch (err) { next(err); }
}

const reactionSchema = z.object({ type: z.enum(['like', 'love', 'haha', 'wow', 'sad', 'angry']) });

export async function setCommentReactionHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { type } = reactionSchema.parse(req.body);
    const result = await setCommentReaction(req.user!.id, req.params.commentId, type);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function toggleCommentsSettingHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { disabled } = z.object({ disabled: z.boolean() }).parse(req.body);
    const result = await toggleCommentsSetting(req.user!.id, disabled);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

const reportCommentSchema = z.object({
  reason: z.enum(['spam', 'harassment', 'hate_speech', 'violence', 'nudity', 'misinformation', 'other']).default('other'),
  details: z.string().max(500).optional(),
});

export async function reportCommentHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { reason, details } = reportCommentSchema.parse(req.body ?? {});
    const result = await reportComment(req.user!.id, req.params.commentId, reason, details);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}
