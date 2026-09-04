import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';

export function toPrivateProfile(user: any) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    bio: user.bio,
    profilePictureUrl: user.profilePictureUrl,
    coverPhotoUrl: user.coverPhotoUrl,
    profileCompleted: user.profileCompleted,
    commentsDisabled: user.commentsDisabled,
  };
}

export function toPublicProfile(user: any) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    bio: user.bio,
    profilePictureUrl: user.profilePictureUrl,
    coverPhotoUrl: user.coverPhotoUrl,
  };
}

export async function getPublicProfileByUsername(username: string) {
  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found.');
  return toPublicProfile(user);
}

function normalizeData(data: any) {
  const result = { ...data };
  if (result.dateOfBirth) {
    result.dateOfBirth = new Date(result.dateOfBirth);
  }
  return result;
}

export async function completeProfile(userId: string, data: any) {
  const existing = await prisma.user.findUnique({ where: { username: data.username } });
  if (existing && existing.id !== userId) {
    throw new ApiError(409, 'USERNAME_TAKEN', 'Username already taken.');
  }
  return prisma.user.update({
    where: { id: userId },
    data: { ...normalizeData(data), profileCompleted: true },
  });
}

export async function updateProfile(userId: string, data: any) {
  if (data.username) {
    const existing = await prisma.user.findUnique({ where: { username: data.username } });
    if (existing && existing.id !== userId) {
      throw new ApiError(409, 'USERNAME_TAKEN', 'Username already taken.');
    }
  }
  return prisma.user.update({ where: { id: userId }, data: normalizeData(data) });
}

export async function searchUsers(query: string) {
  const users = await prisma.user.findMany({
    where: {
      OR: [
        { username: { contains: query } },
        { displayName: { contains: query } },
      ],
    },
    take: 20,
  });
  return users.map(toPublicProfile);
}
