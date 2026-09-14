import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../utils/ApiResponse';
import { ApiError } from '../middleware/errorHandler';
import { profileSetupSchema, profileUpdateSchema } from '../utils/validators/profileValidators';
import { completeProfile, updateProfile, getPublicProfileByUsername, toPrivateProfile, searchUsers } from '../services/userService';
import { reportUser } from '../services/userReportService';
import { prisma } from '../config/prisma';
import { uploadToR2 } from '../config/r2';
import { z } from 'zod';

export async function getMyProfile(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    sendSuccess(res, { user: toPrivateProfile(user) });
  } catch (err) { next(err); }
}

export async function getPublicProfile(req: Request, res: Response, next: NextFunction) {
  try {
    const profile = await getPublicProfileByUsername(req.params.username, req.user?.id);
    sendSuccess(res, { user: profile });
  } catch (err) { next(err); }
}

export async function postProfileSetup(req: Request, res: Response, next: NextFunction) {
  try {
    const existing = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (existing?.profileCompleted) {
      throw new ApiError(403, 'PROFILE_ALREADY_COMPLETED', 'Profile setup already completed. Use Edit Profile to make changes.');
    }
    const data = profileSetupSchema.parse(req.body);
    const user = await completeProfile(req.user!.id, data);
    sendSuccess(res, { user: toPrivateProfile(user) });
  } catch (err) { next(err); }
}

export async function patchMyProfile(req: Request, res: Response, next: NextFunction) {
  try {
    const data = profileUpdateSchema.parse(req.body);
    const user = await updateProfile(req.user!.id, data as any);
    sendSuccess(res, { user: toPrivateProfile(user) });
  } catch (err) { next(err); }
}

export async function searchUsersHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const query = (req.query.q as string) || '';
    const users = query.length > 0 ? await searchUsers(query) : [];
    sendSuccess(res, { users });
  } catch (err) { next(err); }
}

export async function getMyDashboard(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    sendSuccess(res, { earnings: user?.walletBalance ?? 0 });
  } catch (err) { next(err); }
}

export async function deleteMyAccount(req: Request, res: Response, next: NextFunction) {
  try {
    await prisma.user.delete({ where: { id: req.user!.id } });
    res.clearCookie('vynzo_token', { secure: true, sameSite: 'none' as const, domain: '.frianzo.online' });
    sendSuccess(res, { deleted: true });
  } catch (err) { next(err); }
}

const reportUserSchema = z.object({
  reason: z.enum(['spam', 'harassment', 'hate_speech', 'violence', 'nudity', 'misinformation', 'other']).default('other'),
  details: z.string().max(500).optional(),
});

export async function reportUserHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const { reason, details } = reportUserSchema.parse(req.body ?? {});
    const result = await reportUser(req.user!.id, req.params.userId, reason, details);
    sendSuccess(res, result);
  } catch (err) { next(err); }
}

export async function updateAvatarHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.file) throw new ApiError(400, 'NO_FILE', 'No image uploaded.');
    const url = await uploadToR2(req.file.buffer, req.file.mimetype, 'avatars');
    const user = await updateProfile(req.user!.id, { profilePictureUrl: url } as any);
    sendSuccess(res, { user: toPrivateProfile(user) });
  } catch (err) { next(err); }
}

export async function updateCoverHandler(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.file) throw new ApiError(400, 'NO_FILE', 'No image uploaded.');
    const url = await uploadToR2(req.file.buffer, req.file.mimetype, 'covers');
    const user = await updateProfile(req.user!.id, { coverPhotoUrl: url } as any);
    sendSuccess(res, { user: toPrivateProfile(user) });
  } catch (err) { next(err); }
}
