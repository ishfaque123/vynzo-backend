import { createHash, randomInt } from 'crypto';
import { prisma } from '../config/prisma';
import { env } from '../config/env';
import { ApiError } from '../middleware/errorHandler';

const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function hashCode(email: string, code: string) {
  return createHash('sha256')
    .update(`${email}:${code}:${env.jwtSecret}`)
    .digest('hex');
}

function validateEmail(email: string) {
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\\.[^\s@]+$/.test(email)) {
    throw new ApiError(400, 'INVALID_EMAIL', 'Enter a valid email address.');
  }
}

async function sendVerificationEmail(email: string, code: string) {
  if (!env.emailLoginEnabled) {
    throw new ApiError(503, 'EMAIL_LOGIN_NOT_CONFIGURED', 'Email verification is not configured.');
  }

  const response = await fetch(
    `https://api.mail.hostinger.com/api/v1/mailboxes/${encodeURIComponent(env.hostingerMailboxResourceId)}/send`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.hostingerMailApiToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        to: [email],
        subject: 'Your Frianzo verification code',
        text: `Your Frianzo verification code is ${code}. It expires in 10 minutes. If you did not request this code, you can ignore this email.`,
        html: `<div style="font-family:Arial,sans-serif;line-height:1.5"><h2>Frianzo verification</h2><p>Your verification code is:</p><p style="font-size:28px;font-weight:700;letter-spacing:6px">${code}</p><p>This code expires in 10 minutes.</p><p>If you did not request this code, you can ignore this email.</p></div>`,
      }),
      signal: AbortSignal.timeout(10000),
    },
  );

  if (!response.ok) {
    throw new ApiError(502, 'EMAIL_SEND_FAILED', 'Could not send the verification email.');
  }
}

export async function requestEmailVerification(rawEmail: string) {
  const email = normalizeEmail(rawEmail);
  validateEmail(email);

  const latest = await prisma.emailVerificationCode.findFirst({
    where: { email, usedAt: null },
    orderBy: { createdAt: 'desc' },
  });

  if (latest && Date.now() - latest.createdAt.getTime() < RESEND_COOLDOWN_MS) {
    throw new ApiError(429, 'OTP_COOLDOWN', 'Please wait before requesting another code.');
  }

  const code = String(randomInt(100000, 1000000));
  const codeHash = hashCode(email, code);
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);

  await prisma.emailVerificationCode.updateMany({
    where: { email, usedAt: null },
    data: { usedAt: new Date() },
  });

  const record = await prisma.emailVerificationCode.create({
    data: { email, codeHash, expiresAt },
  });

  try {
    await sendVerificationEmail(email, code);
  } catch (error) {
    await prisma.emailVerificationCode.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    });
    throw error;
  }

  return { sent: true };
}

export async function consumeEmailVerification(rawEmail: string, code: string) {
  const email = normalizeEmail(rawEmail);
  validateEmail(email);

  if (!/^\d{6}$/.test(code)) {
    throw new ApiError(400, 'INVALID_VERIFICATION_CODE', 'Enter the 6-digit verification code.');
  }

  const record = await prisma.emailVerificationCode.findFirst({
    where: { email, usedAt: null },
    orderBy: { createdAt: 'desc' },
  });

  if (!record || record.expiresAt.getTime() <= Date.now()) {
    throw new ApiError(400, 'VERIFICATION_CODE_EXPIRED', 'The verification code has expired.');
  }

  if (record.attempts >= MAX_ATTEMPTS) {
    throw new ApiError(429, 'TOO_MANY_CODE_ATTEMPTS', 'Too many incorrect attempts. Request a new code.');
  }

  const valid = hashCode(email, code) === record.codeHash;
  if (!valid) {
    await prisma.emailVerificationCode.update({
      where: { id: record.id },
      data: { attempts: { increment: 1 } },
    });
    throw new ApiError(400, 'INVALID_VERIFICATION_CODE', 'The verification code is incorrect.');
  }

  await prisma.emailVerificationCode.update({
    where: { id: record.id },
    data: { usedAt: new Date() },
  });

  return email;
}
