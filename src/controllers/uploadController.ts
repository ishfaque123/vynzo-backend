import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../utils/ApiResponse';
import { ApiError } from '../middleware/errorHandler';
import { uploadToR2 } from '../config/r2';
import { prisma } from '../config/prisma';

export async function uploadAvatarHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.file) throw new ApiError(400, 'NO_FILE', 'No image uploaded.');
    const url = await uploadToR2(req.file.buffer, req.file.mimetype, 'avatars');
    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: { profilePictureUrl: url },
    });
    sendSuccess(res, { profilePictureUrl: user.profilePictureUrl });
  } catch (err) { next(err); }
}

export async function uploadCoverHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.file) throw new ApiError(400, 'NO_FILE', 'No image uploaded.');
    const url = await uploadToR2(req.file.buffer, req.file.mimetype, 'covers');
    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: { coverPhotoUrl: url },
    });
    sendSuccess(res, { coverPhotoUrl: user.coverPhotoUrl });
  } catch (err) { next(err); }
}
