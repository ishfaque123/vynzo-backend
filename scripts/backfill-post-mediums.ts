/**
 * One-time post-photo medium backfill — DO NOT RUN against live production
 * data without a separate owner check (see PLAN.md in the staging workdir).
 *
 * For every post whose imageUrl is an R2 posts/ URL, generates the ~720px
 * medium (posts/<uuid>-medium.jpg) if it does not already exist, so the
 * feed can load the medium instead of the full photo for old posts too.
 * It writes NO database rows: mediums are found by naming convention.
 *
 * Chunked + resumable: existing mediums are skipped via HeadObject, so a
 * re-run never redoes finished posts. Use --limit to bound a run and
 * --after=<postId> to resume after the last post id of the previous run.
 * Progress is logged every 100 posts.
 *
 * Usage (on the VM, from the backend repo root, after backing up):
 *   npx ts-node scripts/backfill-post-mediums.ts --dry-run
 *   npx ts-node scripts/backfill-post-mediums.ts --limit 500
 *   npx ts-node scripts/backfill-post-mediums.ts --limit 500 --after=<lastPostId>
 */
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { prisma } from '../src/config/prisma';
import { r2Client, uploadBufferToKey } from '../src/config/r2';
import { env } from '../src/config/env';
import { compressPostMediumBuffer, mediumKeyForUrl } from '../src/services/imageCompressService';

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitArg = args.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 10000;
  const afterArg = args.find((a) => a.startsWith('--after='));
  const after = afterArg ? afterArg.split('=')[1] : undefined;

  const posts = await prisma.post.findMany({
    where: { imageUrl: { contains: '/posts/' } },
    select: { id: true, imageUrl: true },
    orderBy: { id: 'asc' },
    take: limit,
    ...(after ? { cursor: { id: after }, skip: 1 } : {}),
  });
  console.log(`[backfill-medium] ${posts.length} photo posts to check (dryRun=${dryRun}, after=${after ?? 'start'})`);

  let created = 0;
  let skipped = 0;
  let failed = 0;
  let processed = 0;
  let lastId = after ?? '';
  for (const post of posts) {
    lastId = post.id;
    const fullUrl = post.imageUrl!;
    const mediumKey = mediumKeyForUrl(fullUrl, env.r2PublicUrl);
    if (!mediumKey) { skipped++; continue; }
    try {
      await r2Client.send(new HeadObjectCommand({ Bucket: env.r2BucketName, Key: mediumKey }));
      skipped++; // medium already exists
      continue;
    } catch { /* 404: medium missing, generate it */ }
    try {
      const res = await fetch(fullUrl);
      if (!res.ok) throw new Error(`fetch ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const medium = await compressPostMediumBuffer(buf, res.headers.get('content-type') || 'image/jpeg');
      if (!medium) throw new Error('medium generation returned null (non-compressible type, e.g. HEIF)');
      if (!dryRun) await uploadBufferToKey(medium, mediumKey, 'image/jpeg');
      created++;
    } catch (err) {
      failed++;
      console.error(`[backfill-medium] failed for post ${post.id}:`, (err as Error).message);
    }
    processed++;
    if (processed % 100 === 0) {
      console.log(`[backfill-medium] progress: processed=${processed} created=${created} skipped=${skipped} failed=${failed} lastId=${lastId}`);
    }
  }
  console.log(`[backfill-medium] done: created=${created} skipped=${skipped} failed=${failed} lastId=${lastId}`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('[backfill-medium] fatal', err);
  await prisma.$disconnect();
  process.exit(1);
});
