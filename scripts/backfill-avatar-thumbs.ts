/**
 * One-time avatar thumbnail backfill — DO NOT RUN against live production
 * data without a separate owner check (see README in the workdir).
 *
 * For every user whose profilePictureUrl is an R2 avatar URL, generates the
 * ~96px thumbnail (avatars/<uuid>-thumb.jpg) if it does not already exist.
 * It writes NO database rows: thumbnails are found by naming convention, so
 * old avatars start loading fast as soon as their thumb exists.
 *
 * Usage (on the VM, from the backend repo root, after backing up):
 *   npx ts-node scripts/backfill-avatar-thumbs.ts --dry-run
 *   npx ts-node scripts/backfill-avatar-thumbs.ts --limit 500
 */
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { prisma } from '../src/config/prisma';
import { r2Client, uploadBufferToKey } from '../src/config/r2';
import { env } from '../src/config/env';
import { compressThumbnailBuffer, avatarThumbKeyForUrl } from '../src/services/imageCompressService';

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitArg = args.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 10000;

  const users = await prisma.user.findMany({
    where: { profilePictureUrl: { contains: '/avatars/' } },
    select: { id: true, profilePictureUrl: true },
    take: limit,
  });
  console.log(`[backfill] ${users.length} avatar users to check (dryRun=${dryRun})`);

  let created = 0;
  let skipped = 0;
  let failed = 0;
  for (const user of users) {
    const fullUrl = user.profilePictureUrl!;
    const thumbKey = avatarThumbKeyForUrl(fullUrl, env.r2PublicUrl);
    if (!thumbKey) { skipped++; continue; }
    try {
      await r2Client.send(new HeadObjectCommand({ Bucket: env.r2BucketName, Key: thumbKey }));
      skipped++; // thumbnail already exists
      continue;
    } catch { /* 404: thumbnail missing, generate it */ }
    try {
      const res = await fetch(fullUrl);
      if (!res.ok) throw new Error(`fetch ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const thumb = await compressThumbnailBuffer(buf, res.headers.get('content-type') || 'image/jpeg');
      if (!thumb) throw new Error('thumbnail generation returned null');
      if (!dryRun) await uploadBufferToKey(thumb, thumbKey, 'image/jpeg');
      created++;
    } catch (err) {
      failed++;
      console.error(`[backfill] failed for user ${user.id}:`, (err as Error).message);
    }
  }
  console.log(`[backfill] done: created=${created} skipped=${skipped} failed=${failed}`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('[backfill] fatal', err);
  await prisma.$disconnect();
  process.exit(1);
});
