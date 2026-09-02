import { prisma } from '../config/prisma';
import { verifyGoogleIdToken } from '../config/googleAuth';
import { signToken } from '../utils/jwt';

export async function loginWithGoogle(idToken: string) {
  const { googleId } = await verifyGoogleIdToken(idToken);

  let user = await prisma.user.findUnique({ where: { googleId } });
  let isNewUser = false;

  if (!user) {
    user = await prisma.user.create({ data: { googleId } });
    isNewUser = true;
  } else {
    user = await prisma.user.update({
      where: { id: user.id },
      data: { lastActiveAt: new Date() },
    });
  }

  const token = signToken({ userId: user.id });
  return { token, user, isNewUser };
}
