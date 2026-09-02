import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';

export function toPublicProfile(user: any) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    bio: user.bio,
    profilePictureUrl: user.profilePictureUrl,
    createdAt: user.createdAt,
  };
}

export function toPrivateProfile(user: any) {
  return {
    ...toPublicProfile(user),
    dateOfBirth: user.dateOfBirth,
    profileCompleted: user.profileCompleted,
    accountStatus: user.accountStatus,
    role: user.role,
  };
}

export async function completeProfile(userId: string, data: {
  username: string; displayName: string; dateOfBirth: string; bio?: string;
}) {
  const existing = await prisma.user.findUnique({ where: { username: data.username } });
  if (existing && existing.id !== userId) {
    throw new ApiError(409, 'USERNAME_TAKEN', 'This username is already taken.');
  }

  return prisma.user.update({
    where: { id: userId },
    data: {
      username: data.username,
      displayName: data.displayName,
      dateOfBirth: new Date(data.dateOfBirth),
      bio: data.bio,
      profileCompleted: true,
    },
  });
}

export async function updateProfile(userId: string, data: Partial<{
  username: string; displayName: string; bio: string;
}>) {
  if (data.username) {
    const existing = await prisma.user.findUnique({ where: { username: data.username } });
    if (existing && existing.id !== userId) {
      throw new ApiError(409, 'USERNAME_TAKEN', 'This username is already taken.');
    }
  }
  return prisma.user.update({ where: { id: userId }, data });
}

export async function getPublicProfileByUsername(username: string) {
  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found.');
  return toPublicProfile(user);
}
