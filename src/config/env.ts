import dotenv from 'dotenv';
dotenv.config();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 5000,
  databaseUrl: requireEnv('DATABASE_URL'),
  frontendUrl: requireEnv('FRONTEND_URL'),
  googleClientId: requireEnv('GOOGLE_CLIENT_ID'),
  googleClientSecret: requireEnv('GOOGLE_CLIENT_SECRET'),
  googleRedirectUri: requireEnv('GOOGLE_REDIRECT_URI'),
  jwtSecret: requireEnv('JWT_SECRET'),
  jwtExpiresIn: '7d',
  r2Endpoint: requireEnv('R2_ENDPOINT'),
  r2AccessKeyId: requireEnv('R2_ACCESS_KEY_ID'),
  r2SecretAccessKey: requireEnv('R2_SECRET_ACCESS_KEY'),
  r2BucketName: requireEnv('R2_BUCKET_NAME'),
  r2PublicUrl: requireEnv('R2_PUBLIC_URL'),
  // Kill-switch for the Reels feature. Set REELS_ENABLED=false in
  // Railway's environment variables to turn uploading and viewing
  // reels off app-wide without a deploy. Anything else (unset,
  // 'true', etc.) keeps it on.
  reelsEnabled: process.env.REELS_ENABLED !== 'false',
  reelMaxDurationSec: 60,
  reelDailyLimit: 1,
  emailLoginEnabled: Boolean(process.env.HOSTINGER_MAIL_API_TOKEN && process.env.HOSTINGER_MAILBOX_RESOURCE_ID),
  hostingerMailApiToken: process.env.HOSTINGER_MAIL_API_TOKEN || '',
  hostingerMailboxResourceId: process.env.HOSTINGER_MAILBOX_RESOURCE_ID || '',
};
