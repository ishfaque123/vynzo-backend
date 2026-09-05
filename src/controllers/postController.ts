import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../utils/ApiResponse';
import { createPost, getFeed, deletePost, sharePost, getPostById, getPostsByUsername } from '../services/postService';
import { setReaction } from '../services/likeService';
import { uploadToR2 } from '../config/r2';
import { z } from 'zod';

const createPostSchema = z.object({
  content: z.string().min(1).max(2000),
  visibility: z.enum(['public', 'private']).optional(),
  taggedUserIds: z.string().optional(),
});

export async function createPostHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { content, visibility, taggedUserIds } = createPostSchema.parse(req.body);
    let imageUrl: string | undefined;
    if (req.file) {
      imageUrl = await uploadToR2(req.file.buffer, req.file.mimetype, 'posts');
    }
    const tagIds = taggedUserIds ? JSON.parse(taggedUserIds) : [];
    const post = await createPost(req.user!.id, content, imageUrl, visibility || 'public', tagIds);
    sendSuccess(res, { post }, 201);
  } catch (err) { next(err); }
}

export async function getFeedHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const posts = await getFeed(req.user?.id, 20);
    sendSuccess(res, { posts });
  } catch (err) { next(err); }
}

export async function getPostHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const post = await getPostById(req.params.id, req.user?.id);
    sendSuccess(res, { post });
  } catch (err) { next(err); }
}

export async function getUserPostsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const posts = await getPostsByUsername(req.params.username, req.user?.id);
    sendSuccess(res, { posts });
  } catch (err) { next(err); }
}

export async function deletePostHandler(req: Request, res: Response, next: NextFunction) {
  try {
    await deletePost(req.user!.id, req.params.id);
    sendSuccess(res, { deleted: true });
  } catch (err) { next(err); }
}

const reactionSchema = z.object({
  type: z.enum(['like', 'love', 'haha', 'wow', 'sad', 'angry']),
});

export async function setReactionHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { type } = reactionSchema.parse(req.body);
    const result = await setReaction(req.user!.id, req.params.id, type);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

const sharePostSchema = z.object({
  content: z.string().max(2000).optional().default(''),
});

export async function sharePostHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { content } = sharePostSchema.parse(req.body);
    const post = await sharePost(req.user!.id, req.params.id, content);
    sendSuccess(res, { post }, 201);
  } catch (err) { next(err); }
}
