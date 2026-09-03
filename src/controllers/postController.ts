import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../utils/ApiResponse';
import { createPost, getFeed, deletePost } from '../services/postService';
import { toggleLike } from '../services/likeService';
import { z } from 'zod';

const createPostSchema = z.object({
  content: z.string().min(1).max(2000),
});

export async function createPostHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { content } = createPostSchema.parse(req.body);
    const post = await createPost(req.user!.id, content);
    sendSuccess(res, { post }, 201);
  } catch (err) {
    next(err);
  }
}

export async function getFeedHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const posts = await getFeed(req.user?.id, 20);
    sendSuccess(res, { posts });
  } catch (err) {
    next(err);
  }
}

export async function deletePostHandler(req: Request, res: Response, next: NextFunction) {
  try {
    await deletePost(req.user!.id, req.params.id);
    sendSuccess(res, { deleted: true });
  } catch (err) {
    next(err);
  }
}

export async function toggleLikeHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await toggleLike(req.user!.id, req.params.id);
    sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
}
