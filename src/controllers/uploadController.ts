import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../utils/ApiResponse';
import { ApiError } from '../middleware/errorHandler';
import { uploadToR2, uploadStreamToR2 } from '../config/r2';
import { compressImageBuffer, compressImageFile } from '../services/imageCompressService';
import { createReadStream } from 'fs';
import { rm } from 'fs/promises';
import { prisma } from '../config/prisma';
import { createPost } from '../services/postService';

export async function uploadAvatarHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.file) throw new ApiError(400, 'NO_FILE', 'No image uploaded.');
    const avatarImg = await compressImageBuffer(req.file.buffer, req.file.mimetype);
    const url = await uploadToR2(avatarImg.buffer, avatarImg.mimeType, 'avatars');
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
    // Chat uploads now arrive on disk (see chatUpload): compress and
    // stream from the file instead of holding it in RAM.
    const uploadedPath = req.file.path;
    try {
      const chatImg = await compressImageFile(uploadedPath, req.file.mimetype);
      try {
        const ext = (chatImg.mimeType.split('/')[1] || 'jpg').split(';')[0];
        const url = await uploadStreamToR2(createReadStream(chatImg.filePath), chatImg.mimeType, 'chat-media', ext);
        const mediaType = req.file.mimetype.startsWith('audio/') ? 'voice' : 'image';
        sendSuccess(res, { url, mediaType });
      } finally {
        await chatImg.cleanup();
      }
    } finally {
      await rm(uploadedPath, { force: true }).catch(() => {});
    }
  } catch (err) { next(err); }
}
