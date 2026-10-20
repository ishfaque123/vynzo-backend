import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../utils/ApiResponse';
import {
  createPost, getFeed, deletePost, sharePost, getPostById, getPostsByUsername,
  updatePost, reportPost, hidePost, togglePinPost, getContentMix,
} from '../services/postService';
import { setReaction } from '../services/likeService';
import { recordPostView } from '../services/postAnalyticsService';
import { uploadToR2 } from '../config/r2';
import { compressImageBuffer } from '../services/imageCompressService';
import { z } from 'zod';
import { ApiError } from '../middleware/errorHandler';

const createPostSchema = z.object({
  content: z.string().max(2000).optional().default(''),
  visibility: z.enum(['public', 'private']).optional(),
  taggedUserIds: z.string().optional(),
  commentAudience: z.enum(['everyone', 'followers', 'only_me']).optional(),
  backgroundStyle: z.enum(['sunset', 'ocean', 'violet', 'mint', 'peach', 'night', 'rose', 'sky']).optional(),
  location: z.string().max(200).optional(),
});

export async function createPostHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { content, visibility, taggedUserIds, commentAudience, backgroundStyle, location } = createPostSchema.parse(req.body);
    if (backgroundStyle && req.file) throw new ApiError(400, 'POST_BACKGROUND_WITH_IMAGE', 'Text post backgrounds cannot be used with a photo.');
    let imageUrl: string | undefined;
    if (req.file) {
      const postImg = await compressImageBuffer(req.file.buffer, req.file.mimetype);
      imageUrl = await uploadToR2(postImg.buffer, postImg.mimeType, 'posts');
    }
    if (!content.trim() && !imageUrl) throw new ApiError(400, 'POST_CONTENT_REQUIRED', 'Post must contain text or an image.');
    let tagIds: string[] = [];
    if (taggedUserIds) {
      try {
        tagIds = z.array(z.string().min(1).max(64)).parse(JSON.parse(taggedUserIds));
      } catch {
        throw new ApiError(400, 'INVALID_TAG_IDS', 'Tagged users must be a JSON array of user IDs.');
      }
    }
    const post = await createPost(req.user!.id, content.trim(), imageUrl, visibility || 'public', tagIds, commentAudience || 'everyone', backgroundStyle, location);
    sendSuccess(res, { post }, 201);
  } catch (err) { next(err); }
}

export async function getFeedHandler(req: Request, res: Response, next: NextFunction) {
  try {
    // FB-style small batches (was 20, then 10): user-ordered 2026-10-20 —
    // total first-screen cards (posts + injected reels) should be ~10, so
    // posts batch is 5 and the frontend paginates with offset on scroll.
    const limit = 5;
    const rawOffset = parseInt(String(req.query.offset ?? '0'), 10);
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;
    const { posts, hasMore } = await getFeed(req.user?.id, limit, offset);
    sendSuccess(res, { posts, hasMore, nextOffset: offset + posts.length });
  } catch (err) { next(err); }
}

export async function getContentMixHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await getContentMix(req.user!.id);
    sendSuccess(res, data);
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

const updatePostSchema = z.object({
  content: z.string().min(1).max(2000).optional(),
  commentAudience: z.enum(['everyone', 'followers', 'only_me']).optional(),
});

export async function updatePostHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const data = updatePostSchema.parse(req.body);
    const post = await updatePost(req.user!.id, req.params.id, data);
    sendSuccess(res, { post });
  } catch (err) { next(err); }
}

export async function deletePostHandler(req: Request, res: Response, next: NextFunction) {
  try {
    await deletePost(req.user!.id, req.params.id);
    sendSuccess(res, { deleted: true });
  } catch (err) { next(err); }
}

export async function togglePinPostHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const post = await togglePinPost(req.user!.id, req.params.id);
    sendSuccess(res, { post });
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

const sharePostSchema = z.object({ content: z.string().max(2000).optional().default('') });

export async function sharePostHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { content } = sharePostSchema.parse(req.body);
    const post = await sharePost(req.user!.id, req.params.id, content);
    sendSuccess(res, { post }, 201);
  } catch (err) { next(err); }
}

const reportPostSchema = z.object({
  reason: z.enum(['spam', 'harassment', 'hate_speech', 'violence', 'nudity', 'misinformation', 'other']).default('other'),
  details: z.string().max(500).optional(),
});

export async function reportPostHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { reason, details } = reportPostSchema.parse(req.body ?? {});
    const result = await reportPost(req.user!.id, req.params.id, reason, details);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function hidePostHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await hidePost(req.user!.id, req.params.id);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function recordPostViewHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const watchSec = Number(req.body?.watchSec) || 0;
    sendSuccess(res, await recordPostView(req.user!.id, req.params.id, watchSec));
  } catch (err) { next(err); }
}
