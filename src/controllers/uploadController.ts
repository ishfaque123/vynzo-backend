import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../utils/ApiResponse';
import { ApiError } from '../middleware/errorHandler';
import { uploadToR2, uploadBufferToKey } from '../config/r2';
import { compressImageBuffer, compressThumbnailBuffer, avatarThumbKeyForUrl } from '../services/imageCompressService';
import { env } from '../config/env';
import { prisma } from '../config/prisma';
import { createPost } from '../services/postService';

export async function uploadAvatarHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.file) throw new ApiError(400, 'NO_FILE', 'No image uploaded.');
    const avatarImg = await compressImageBuffer(req.file.buffer, req.file.mimetype);
    const url = await uploadToR2(avatarImg.buffer, avatarImg.mimeType, 'avatars');
    // Best-effort thumbnail: a ~96px JPEG under the full avatar's key
    // (avatars/<uuid>-thumb.jpg). Never fails the avatar upload itself.
    try {
      const thumb = await compressThumbnailBuffer(req.file.buffer, req.file.mimetype);
      const thumbKey = thumb ? avatarThumbKeyForUrl(url, env.r2PublicUrl) : null;
      if (thumb && thumbKey) await uploadBufferToKey(thumb, thumbKey, 'image/jpeg');
    } catch (err) {
      console.error('[avatar] thumbnail upload failed, keeping full avatar only', err);
    }
    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: { profilePictureUrl: url },
    });
    sendSuccess(res, { profilePictureUrl: user.profilePictureUrl });

    const displayName = user.displayName || user.username;
    // Only create the post if we have a name (skip "Someone" posts)
    if (displayName) {
      createPost(req.user!.id, `${displayName} updated their profile picture`, url, 'public').catch(() => {});
    }
  } catch (err) { next(err); }
}

export async function uploadCoverHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.file) throw new ApiError(400, 'NO_FILE', 'No image uploaded.');
    const coverImg = await compressImageBuffer(req.file.buffer, req.file.mimetype);
    const url = await uploadToR2(coverImg.buffer, coverImg.mimeType, 'covers');
    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: { coverPhotoUrl: url },
    });
    sendSuccess(res, { coverPhotoUrl: user.coverPhotoUrl });
  } catch (err) { next(err); }
}

export async function uploadChatMediaHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.file) throw new ApiError(400, 'NO_FILE', 'No file uploaded.');
    const chatImg = await compressImageBuffer(req.file.buffer, req.file.mimetype);
    const url = await uploadToR2(chatImg.buffer, chatImg.mimeType, 'chat-media');
    const mediaType = req.file.mimetype.startsWith('audio/') ? 'voice' : 'image';
    sendSuccess(res, { url, mediaType });
  } catch (err) { next(err); }
}
