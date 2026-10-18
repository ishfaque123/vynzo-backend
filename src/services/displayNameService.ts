import { prisma } from '../config/prisma';

/**
 * Professional fix for "null updated their profile picture" bug.
 * 
 * Root cause: users created without displayName (nullable in schema).
 * This backfills:
 * 1. Users with null displayName -> set to username (or 'User' as last resort)
 * 2. Existing posts starting with "null updated their" -> fix with author's name
 * 
 * Safe and idempotent — runs on every startup, only touches null/broken records.
 */
export async function ensureDisplayNames() {
  try {
    // 1. Backfill null displayNames with username
    const nullNameUsers = await prisma.user.findMany({
      where: { displayName: null, username: { not: null } },
      select: { id: true, username: true },
    });

    for (const u of nullNameUsers) {
      await prisma.user.update({
        where: { id: u.id },
        data: { displayName: u.username },
      });
    }

    // Users with neither displayName nor username -> set generic
    await prisma.user.updateMany({
      where: { displayName: null, username: null },
      data: { displayName: 'User' },
    });

    // 2. Fix existing "null updated their profile picture" posts
    const brokenPosts = await prisma.post.findMany({
      where: { content: { startsWith: 'null updated their' } },
      select: { id: true, authorId: true },
    });

    for (const p of brokenPosts) {
      const author = await prisma.user.findUnique({
        where: { id: p.authorId },
        select: { displayName: true, username: true },
      });
      const name = author?.displayName || author?.username || 'Someone';
      await prisma.post.update({
        where: { id: p.id },
        data: { content: `${name} updated their profile picture` },
      });
    }

    const fixed = nullNameUsers.length + brokenPosts.length;
    if (fixed > 0) {
      console.log(`[display-names] Fixed ${nullNameUsers.length} null displayNames, ${brokenPosts.length} broken posts`);
    }
  } catch (err) {
    // Non-fatal: log and continue startup
    console.error('[display-names] Backfill failed (non-fatal):', (err as Error).message);
  }
}
