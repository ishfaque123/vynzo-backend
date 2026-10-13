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
const MODEL = '@cf/meta/llama-3.1-8b-instruct';

// Fast local pre-check: obvious spam / slur patterns (any language), so we
// don't burn AI quota on the obvious stuff. Llama Guard handles the rest.
const BLOCKED_PATTERNS: RegExp[] = [
  // spam links / promos
  /https?:\/\/\S+/i,
  /\b(free money|earn money|click here|buy followers|viagra|casino|betting)\b/i,
  // severe profanity (EN + Roman Urdu) — mild words like idiot/stupid are ALLOWED
  /\b(fuck|motherfucker|bitch|asshole|bastard|slut|whore|dick|pussy|cunt)\b/i,
  /\b(bhenchod|behenchod|madarchod|chutiya|gandu|harami)\b/i,
  // threats
  /\b(kill you|i will kill|murder you)\b/i,
];



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
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${MODEL}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${CF_AI_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            { role: 'system', content:
                'You are a content moderator for a social media app (like Facebook/Instagram). Classify the user comment as VIOLATION or OK. ' +
                'Mark VIOLATION only for: severe profanity/swear words, slurs, hate speech (targeting race/religion/gender), sexual/explicit language, ' +
                'threats of violence, harassment/bullying, spam/scam links. ' +
                'Mark OK for: mild words like idiot/stupid/dumb, disagreements, criticism, sarcasm, normal conversation. ' +
                'Reply with OK if fine, or VIOLATION followed by a 2-4 word reason (e.g. "VIOLATION: profanity", "VIOLATION: hate speech", "VIOLATION: sexual content", "VIOLATION: threats", "VIOLATION: spam"). ' +
                'Reply with ONLY that, nothing else.' },
            { role: 'user', content: content.slice(0, 500) },
          ],
        }),
        signal: controller.signal,
      }
    );
    if (!res.ok) { console.error('[moderation] Workers AI error', res.status); return { toxic: false }; }
    const data: any = await res.json();
    const text: string = (data?.result?.response ?? '').trim();
    if (/^violation/i.test(text)) {
      const reason = text.split(':')[1]?.trim().toLowerCase() || 'community guidelines violation';
      return { toxic: true, reason: reason.slice(0, 60) };
    }
    return { toxic: false };
  } catch (err) { console.error('[moderation] AI check failed (fail-open)', err); return { toxic: false }; }
  finally { clearTimeout(timer); }
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
    if (columnType && (!columnType.includes("'comment_removed'") || !columnType.includes("'post_removed'"))) {
      const values: string[] = columnType.match(/'[^']+'/g) ?? [];
      if (!values.includes("'comment_removed'")) values.push("'comment_removed'");
      if (!values.includes("'post_removed'")) values.push("'post_removed'");
      await prisma.$executeRawUnsafe(`ALTER TABLE notifications MODIFY COLUMN type ENUM(${values.join(',')}) NOT NULL`);
      console.log('[moderation] added comment_removed/post_removed to notification types');
    }
  } catch (err) {
    console.error('[moderation] enum ensure failed', err);
  }
  enumReady = true;
}

/**
 * Background moderation for a freshly created post.
 * Deletes the post + notifies the author if it violates guidelines. Never throws.
 */
export async function moderatePost(postId: string): Promise<void> {
  try {
    const post = await prisma.post.findUnique({ where: { id: postId }, select: { id: true, userId: true, content: true } });
    if (!post || !post.content?.trim()) return;
    const { toxic, reason } = await checkCommentToxicity(post.content);
    if (!toxic) return;
    const stillThere = await prisma.post.findUnique({ where: { id: postId }, select: { id: true } });
    if (!stillThere) return;
    await prisma.post.delete({ where: { id: postId } });
    console.log(`[moderation] deleted violating post ${postId} (${reason})`);
    await ensureCommentRemovedType();
    await createNotification({ userId: post.userId, type: 'post_removed' as any, detail: reason, reaction: reason });
  } catch (err) { console.error('[moderation] moderatePost failed', err); }
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
      detail: reason, // stored + shown in-app and in push
      reaction: reason, // push text slot
    });
  } catch (err) {
    console.error('[moderation] moderateComment failed', err);
  }
}
