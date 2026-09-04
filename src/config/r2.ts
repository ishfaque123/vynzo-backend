import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { env } from './env';
import { randomUUID } from 'crypto';

export const r2Client = new S3Client({
  region: 'auto',
  endpoint: env.r2Endpoint,
  credentials: {
    accessKeyId: env.r2AccessKeyId,
    secretAccessKey: env.r2SecretAccessKey,
  },
});

export async function uploadToR2(buffer: Buffer, mimeType: string, folder: string) {
  const ext = mimeType.split('/')[1] || 'jpg';
  const key = `${folder}/${randomUUID()}.${ext}`;

  await r2Client.send(
    new PutObjectCommand({
      Bucket: env.r2BucketName,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
    })
  );

  return `${env.r2PublicUrl}/${key}`;
}
