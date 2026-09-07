import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';
import { getFriendStatus } from './followService';

const COOLDOWN_DAYS = 30;

export function toPrivateProfile(user: any) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    bio: user.bio,
    profilePictureUrl: user.profilePictureUrl,
    coverPhotoUrl: user.coverPhotoUrl,
    gender: user.gender,
    website: user.website,
    phone: user.phone,
    province: user.province,
    city: user.city,
    dateOfBirth: user.dateOfBirth,
    profileCompleted: user.profileCompleted,
    commentsDisabled: user.commentsDisabled,
    usernameChangedAt: user.usernameChangedAt,
    displayNameChangedAt: user.displayNameChangedAt,
    dobChangedAt: user.dobChangedAt,
  };
}

export function toPublicProfile(user: any, friendStatus?: string) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    bio: user.bio,
    profilePictureUrl: user.profilePictureUrl,
    coverPhotoUrl: user.coverPhotoUrl,
    website: user.website,
    province: user.province,
    city: user.city,
    friendStatus: friendStatus ?? 'none',
  };
}

export async function getPublicProfileByUsername(username: string, currentUserId?: string) {
  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found.');
  const friendStatus = await getFriendStatus(currentUserId, user.id);
  return toPublicProfile(user, friendStatus);
}

function checkCooldown(lastChanged: Date | null): { allowed: boolean; daysLeft: number } {
  if (!lastChanged) return { allowed: true, daysLeft: 0 };
  const daysSince = (Date.now() - lastChanged.getTime()) / (1000 * 60 * 60 * 24);
  if (daysSince >= COOLDOWN_DAYS) return { allowed: true, daysLeft: 0 };
  return { allowed: false, daysLeft: Math.ceil(COOLDOWN_DAYS - daysSince) };
}

function normalizeData(data: any) {
  const result = { ...data };
  if (result.dateOfBirth) result.dateOfBirth = new Date(result.dateOfBirth);
  return result;
}

export async function completeProfile(userId: string, data: any) {
  const existing = await prisma.user.findUnique({ where: { username: data.username } });
  if (existing && existing.id !== userId) throw new ApiError(409, 'USERNAME_TAKEN', 'Username already taken.');
  const now = new Date();
  return prisma.user.update({
    where: { id: userId },
    data: {
      ...normalizeData(data),
      profileCompleted: true,
      usernameChangedAt: now,
      displayNameChangedAt: now,
      dobChangedAt: now,
    },
  });
}

export async function updateProfile(userId: string, data: any) {
  const current = await prisma.user.findUnique({ where: { id: userId } });
  if (!current) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found.');

  const updateData: any = { ...data };

  if (data.username !== undefined && data.username !== current.username) {
    const cooldown = checkCooldown(current.usernameChangedAt);
    if (!cooldown.allowed) {
      throw new ApiError(403, 'USERNAME_COOLDOWN', `You can change your username again in ${cooldown.daysLeft} day(s).`);
    }
    const existing = await prisma.user.findUnique({ where: { username: data.username } });
    if (existing && existing.id !== userId) throw new ApiError(409, 'USERNAME_TAKEN', 'Username already taken.');
    updateData.usernameChangedAt = new Date();
  }

  if (data.displayName !== undefined && data.displayName !== current.displayName) {
    const cooldown = checkCooldown(current.displayNameChangedAt);
    if (!cooldown.allowed) {
      throw new ApiError(403, 'DISPLAY_NAME_COOLDOWN', `You can change your name again in ${cooldown.daysLeft} day(s).`);
    }
    updateData.displayNameChangedAt = new Date();
  }

  if (data.dateOfBirth !== undefined) {
    const newDob = new Date(data.dateOfBirth).getTime();
    const oldDob = current.dateOfBirth ? current.dateOfBirth.getTime() : null;
    if (newDob !== oldDob) {
      const cooldown = checkCooldown(current.dobChangedAt);
      if (!cooldown.allowed) {
        throw new ApiError(403, 'DOB_COOLDOWN', `You can change your birthday again in ${cooldown.daysLeft} day(s).`);
      }
      updateData.dobChangedAt = new Date();
      updateData.dateOfBirth = new Date(data.dateOfBirth);
    } else {
      delete updateData.dateOfBirth;
    }
  }

  return prisma.user.update({ where: { id: userId }, data: updateData });
}

export async function searchUsers(query: string) {
  const users = await prisma.user.findMany({
    where: { OR: [{ username: { contains: query } }, { displayName: { contains: query } }] },
    take: 20,
  });
  return users.map((u) => toPublicProfile(u));
}
