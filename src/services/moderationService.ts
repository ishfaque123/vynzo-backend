import { prisma } from '../config/prisma';
import { createNotification } from './notificationService';

// ---------------------------------------------------------------------------
// Comment auto-moderation (Cloudflare Workers AI — Llama Guard 3)
// ---------------------------------------------------------------------------
// Flow: comment posts normally -> this runs in the background a few seconds
// later -> if the comment is toxic/spam, it is deleted and the author gets a
// notification explaining why. Fail-open: if the AI call fails for any reason,
// the comment stays (we never delete on an error).
// ---------------------------------------------------------------------------

const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const CF_AI_TOKEN = process.env.CLOUDFLARE_AI_TOKEN ?? '';
const MODEL = '@cf/meta/llama-guard-3-8b';

// Fast local pre-check: obvious spam / slur patterns (any language), so we
// don't burn AI quota on the obvious stuff. Llama Guard handles the rest.
const BLOCKED_PATTERNS: RegExp[] = [
  // spam links / promos
  /https?:\/\/\S+/i,
  /\b(free money|earn money|click here|buy followers|viagra|casino|betting)\b/i,
  // common profanity (EN + Roman Urdu), word-boundaried
  /\b(fuck|shit|bitch|asshole|bastard|slut|whore|dick|pussy|cunt|motherfucker)\b/i,
  /\b(bhenchod|behenchod|madarchod|lulli|chutiya|gandu|harami|kutta|kutti|lanat|jahil)\b/i,
];

const CATEGORY_REASON: Record<string, string> = {
  S1: 'violent content',
  S2: 'illegal activity',
  S3: 'sexual content involving minors',
  S4: 'child exploitation',
  S5: 'defamation',
  S6: 'dangerous advice',
  S7: 'private information',
  S8: 'copyrighted material',
  S9: 'weapons content',
  S10: 'wrongdoing',
  S11: 'explicit sexual content',
  S12: 'election misinformation',
  S13: 'malicious code',
  S14: 'hate speech',
};

function localCheck(content: string): string | null {
  for (const re of BLOCKED_PATTERNS) {
    if (re.test(content)) {
      const m = content.match(re);
      const hit = (m?.[0] ?? '').toLowerCase();
      if (/https?:\/\//i.test(hit) || /free money|earn money|click here|buy followers|viagra|casino|betting/i.test(hit)) {
        return 'spam or promotional links';
      }
      return 'abusive language';
    }
  }
  return null;
}

async function aiCheck(content: string): Promise<{ toxic: boolean; reason?: string }> {
  if (!CF_ACCOUNT_ID || !CF_AI_TOKEN) {
    console.warn('[moderation] Cloudflare AI not configured, skipping AI check');
    return { toxic: false };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${MODEL}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${CF_AI_TOKEN}`,
          'Content-Type': 'application/json',
        },
        // Llama Guard expects chat messages; it applies its own safety policy
        body: JSON.stringify({ messages: [{ role: 'user', content: content.slice(0, 1000) }] }),
        signal: controller.signal,
      }
    );
    if (!res.ok) {
      console.error('[moderation] Workers AI error', res.status);
      return { toxic: false }; // fail-open
    }
    const data: any = await res.json();
    const text: string = (data?.result?.response ?? '').trim().toLowerCase();
    if (text.startsWith('unsafe')) {
      const cats = text.split('\n')[1]?.toUpperCase().match(/S\d+/g) ?? [];
      const reasons = [...new Set(cats.map((c) => CATEGORY_REASON[c]).filter(Boolean))];
      return { toxic: true, reason: reasons[0] ?? 'policy violation' };
    }
    return { toxic: false };
  } catch (err) {
    console.error('[moderation] AI check failed (fail-open)', err);
    return { toxic: false };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkCommentToxicity(content: string): Promise<{ toxic: boolean; reason?: string }> {
  const localReason = localCheck(content);
  if (localReason) return { toxic: true, reason: localReason };
  return aiCheck(content);
}

// Ensure the 'comment_removed' enum value exists on notifications.type.
// Safe + idempotent: only ADDS the value, never removes anything.
let enumReady = false;
async function ensureCommentRemovedType() {
  if (enumReady) return;
  try {
    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT COLUMN_TYPE AS columnType FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notifications' AND COLUMN_NAME = 'type'`
    );
    const columnType: string = rows[0]?.columnType ?? '';
    if (columnType && !columnType.includes("'comment_removed'")) {
      const values = columnType.match(/'[^']+'/g) ?? [];
      const newEnum = [...values, "'comment_removed'"].join(',');
      await prisma.$executeRawUnsafe(`ALTER TABLE notifications MODIFY COLUMN type ENUM(${newEnum}) NOT NULL`);
      console.log('[moderation] added comment_removed to notification types');
    }
  } catch (err) {
    console.error('[moderation] enum ensure failed', err);
  }
  enumReady = true;
}

/**
 * Background moderation for a freshly posted comment.
 * Deletes the comment + notifies the author if toxic. Never throws.
 */
export async function moderateComment(commentId: string): Promise<void> {
  try {
    const comment = await prisma.comment.findUnique({
      where: { id: commentId },
      select: { id: true, userId: true, content: true },
    });
    if (!comment || !comment.content?.trim()) return; // already deleted or empty

    const { toxic, reason } = await checkCommentToxicity(comment.content);
    if (!toxic) return;

    // Re-check existence (user may have deleted it meanwhile)
    const stillThere = await prisma.comment.findUnique({ where: { id: commentId }, select: { id: true } });
    if (!stillThere) return;

    await prisma.comment.delete({ where: { id: commentId } });
    console.log(`[moderation] deleted toxic comment ${commentId} (${reason})`);

    await ensureCommentRemovedType();
    await createNotification({
      userId: comment.userId,
      type: 'comment_removed',
      reaction: reason, // display-only slot -> "Your comment was removed for <reason>"
    });
  } catch (err) {
    console.error('[moderation] moderateComment failed', err);
  }
}
