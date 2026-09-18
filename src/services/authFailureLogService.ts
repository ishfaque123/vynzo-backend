import { prisma } from '../config/prisma';

export type AuthFailureLogInput = {
  platform?: string;
  stage?: string;
  code?: string;
  message: string;
  email?: string;
  appVersion?: string;
  userAgent?: string;
  ipAddress?: string;
};

function clean(value: unknown, max: number) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

export async function logAuthFailure(input: AuthFailureLogInput) {
  try {
    await prisma.authFailureLog.create({
      data: {
        platform: clean(input.platform, 32) || 'unknown',
        stage: clean(input.stage, 64) || 'unknown',
        code: clean(input.code, 128) || 'UNKNOWN',
        message: clean(input.message, 1000) || 'Authentication failed.',
        email: clean(input.email, 320)?.toLowerCase(),
        appVersion: clean(input.appVersion, 64),
        userAgent: clean(input.userAgent, 512),
        ipAddress: clean(input.ipAddress, 64),
      },
    });
  } catch (error) {
    console.error('Failed to persist auth failure log', error);
  }
}
