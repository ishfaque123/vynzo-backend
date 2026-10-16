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
// NOTE (user-ordered 2026-10-16): in comments, ONLY links count as spam —
// normal text is NEVER spam, no matter the words.
const BLOCKED_PATTERNS: RegExp[] = [
  // spam links (Frianzo's own links are stripped before this check)
  /https?:\/\/\S+/i,
  // severe profanity (EN + Roman Urdu) — mild words like idiot/stupid are ALLOWED
  /\b(fuck|motherfucker|bitch|asshole|bastard|slut|whore|dick|pussy|cunt)\b/i,
  /\b(bhenchod|behenchod|madarchod|chutiya|gandu|harami)\b/i,
  // threats
  /\b(kill you|i will kill|murder you)\b/i,
];



function localCheck(content: string): string | null {
  // Frianzo's own links are NEVER spam — strip them before checking.
  // Allowed: frianzo.online (site + user post/reel links), and the official
  // Frianzo Play Store app link. All other external links are spam.
  const OWN_LINK_RE = /https?:\/\/(www\.)?frianzo\.online[^\s]*|https?:\/\/play\.google\.com\/store\/apps\/details\?id=com\.frianzo\.app[^\s]*/gi;
  const contentWithoutOwnLinks = content.replace(OWN_LINK_RE, '');
  for (const re of BLOCKED_PATTERNS) {
    if (re.test(contentWithoutOwnLinks)) {
      const m = contentWithoutOwnLinks.match(re);
      const hit = (m?.[0] ?? '').toLowerCase();
      if (/https?:\/\//i.test(hit)) {
        return 'spam or promotional links';
      }
      return 'abusive language';
    }
  }
  return null;
}

async function aiCheck(content: string): Promise<ToxicityResult> {
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
                'Mark VIOLATION ONLY for CLEAR cases of: severe profanity/swear words, slurs, hate speech (targeting race/religion/gender), sexual/explicit language, ' +
                'threats of violence, harassment/bullying. ' +
                'NEVER mark a comment as spam for its TEXT — only links/URLs count as spam, and those are handled separately. Normal text comments are NEVER spam. ' +
                'When in doubt, mark OK — do NOT flag borderline or mild content. ' +
                'Links to frianzo.online (our own site) and play.google.com/store/apps/details?id=com.frianzo.app are ALWAYS OK, never a violation. ' +
                'Mark OK for: mild words like idiot/stupid/dumb, disagreements, criticism, sarcasm, normal conversation, emojis, short reactions like "nice", "wow", "haha". ' +
                'Reply with OK if fine, or VIOLATION followed by a 2-4 word reason and severity, like "VIOLATION: profanity | SEVERITY: medium". ' +
                'Severity guide: critical = threats of violence, child-safety issues, violent extremism; ' +
                'high = hate speech, explicit sexual content; medium = severe profanity, harassment/bullying; low = mild/borderline (will be ignored). ' +
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
      const afterColon = text.split(':').slice(1).join(':');
      const parts = afterColon.split('|').map((x) => x.trim());
      const reason = (parts[0]?.toLowerCase() || 'community guidelines violation').slice(0, 60);
      const sevMatch = /severity\s*:\s*(low|medium|high|critical)/i.exec(text);
      const severity = (sevMatch?.[1]?.toLowerCase() || 'medium') as 'low' | 'medium' | 'high' | 'critical';
      return { toxic: true, reason, severity };
    }
    return { toxic: false };
  } catch (err) { console.error('[moderation] AI check failed (fail-open)', err); return { toxic: false }; }
  finally { clearTimeout(timer); }
}

export type Severity = 'low' | 'medium' | 'high' | 'critical';
export interface ToxicityResult { toxic: boolean; reason?: string; severity?: Severity }

function severityFromReason(reason: string): Severity {
  const r = reason.toLowerCase();
  if (/threat|kill|die|murder|bomb|terror|child|rape/.test(r)) return 'critical';
  if (/hate|slur|racist|sexual|nude|porn/.test(r)) return 'high';
  return 'medium';
}

export async function checkCommentToxicity(content: string): Promise<ToxicityResult> {
  const localReason = localCheck(content);
  if (localReason) return { toxic: true, reason: localReason, severity: severityFromReason(localReason) };
  return aiCheck(content);
}

// Removal is delayed 5-10 minutes (not instant) so it doesn't feel like instant censorship.
function removalDelayMs(): number {
  return 5 * 60 * 1000 + Math.random() * 5 * 60 * 1000;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Ensure moderation enum values exist on notifications.type + the restriction column.
// Safe + idempotent: only ADDs, never removes/alters.
let enumReady = false;
async function ensureCommentRemovedType() {
  if (enumReady) return;
  try {
    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT COLUMN_TYPE AS columnType FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notifications' AND COLUMN_NAME = 'type'`
    );
    const columnType: string = rows[0]?.columnType ?? '';
    if (columnType && (!columnType.includes("'comment_removed'") || !columnType.includes("'post_removed'") || !columnType.includes("'reel_removed'") || !columnType.includes("'messaging_restricted'"))) {
      const values: string[] = columnType.match(/'[^']+'/g) ?? [];
      for (const v of ["'comment_removed'", "'post_removed'", "'reel_removed'", "'messaging_restricted'"]) {
        if (!values.includes(v)) values.push(v);
      }
      await prisma.$executeRawUnsafe(`ALTER TABLE notifications MODIFY COLUMN type ENUM(${values.join(',')}) NOT NULL`);
      console.log('[moderation] ensured removal notification types');
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
    await sleep(removalDelayMs()); // delayed removal, not instant
    const stillThere = await prisma.post.findUnique({ where: { id: postId }, select: { id: true } });
    if (!stillThere) return;
    await prisma.post.delete({ where: { id: postId } });
    console.log(`[moderation] deleted violating post ${postId} (${reason})`);
    await ensureCommentRemovedType();
    await createNotification({ userId: post.userId, type: 'post_removed' as any, postId: post.id, detail: reason, reaction: reason });
  } catch (err) { console.error('[moderation] moderatePost failed', err); }
}

/**
 * Background moderation for a freshly published reel (caption check).
 * Deletes the reel + notifies the author if it violates guidelines. Never throws.
 */
export async function moderateReel(reelId: string): Promise<void> {
  try {
    const reel = await prisma.reel.findUnique({ where: { id: reelId }, select: { id: true, userId: true, caption: true } });
    if (!reel || !reel.caption?.trim()) return;
    const { toxic, reason } = await checkCommentToxicity(reel.caption);
    if (!toxic) return;
    await sleep(removalDelayMs()); // delayed removal, not instant
    const stillThere = await prisma.reel.findUnique({ where: { id: reelId }, select: { id: true } });
    if (!stillThere) return;
    await prisma.reel.delete({ where: { id: reelId } });
    console.log(`[moderation] deleted violating reel ${reelId} (${reason})`);
    await ensureCommentRemovedType();
    await createNotification({ userId: reel.userId, type: 'reel_removed' as any, detail: reason, reaction: reason });
  } catch (err) { console.error('[moderation] moderateReel failed', err); }
}

/**
 * Ensure all moderation schema objects exist (safe CREATE/ADD only).
 * Called on server startup.
 */
export async function ensureModerationSchema() {
  try {
    // 1. message_restricted_until column on users
    await ensureRestrictColumn();
    // 2. chat_abuse_strikes table - already exists in production, skip creation
    // (FK type mismatch on some DBs caused crashes; table is managed separately)
    console.log('[moderation] skipping chat_abuse_strikes creation (exists)');

    // 3. interests columns for reels personalization (robust: check information_schema first)
    const ensureColumn = async (table: string, column: string, definition: string) => {
      const exists = await prisma.$queryRawUnsafe<Array<{ cnt: bigint }>>(
        'SELECT COUNT(*) as cnt FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        table, column
      );
      if (Number(exists[0]?.cnt || 0) === 0) {
        await prisma.$executeRawUnsafe(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
        console.log(`[moderation] added column ${table}.${column}`);
      }
    };
    await ensureColumn('reels', 'category', 'VARCHAR(50) NULL');
    await ensureColumn('users', 'interests', 'JSON NULL');
    await ensureColumn('users', 'not_interested', 'JSON NULL');
    await ensureColumn('reels', 'category', 'VARCHAR(50) NULL');
    await ensureColumn('post_views', 'watch_sec', 'INT NOT NULL DEFAULT 0');

    // Verify interests columns (fail fast only for these - they're critical for app)
    const critical = [
      ['users', 'interests'],
      ['users', 'not_interested'],
      ['reels', 'category'],
    ] as const;
    for (const [table, column] of critical) {
      const check = await prisma.$queryRawUnsafe<Array<{ cnt: bigint }>>(
        'SELECT COUNT(*) as cnt FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        table, column
      );
      if (Number(check[0]?.cnt || 0) === 0) {
        throw new Error(`FATAL: Required column ${table}.${column} could not be created. Refusing to start.`);
      }
    }
    // 4. ai_agents table for AI commenter agents
    try {
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS \`ai_agents\` (
        \`id\` VARCHAR(36) NOT NULL PRIMARY KEY,
        \`name\` VARCHAR(255) NOT NULL,
        \`username\` VARCHAR(255) NOT NULL UNIQUE,
        \`user_id\` VARCHAR(36) NULL UNIQUE,
        \`gender\` VARCHAR(50) NOT NULL DEFAULT 'neutral',
        \`personality\` TEXT NOT NULL,
        \`system_prompt\` TEXT NOT NULL,
        \`is_active\` BOOLEAN NOT NULL DEFAULT TRUE,
        \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
      )`);
    } catch (e: any) {
      console.error('[moderation] ai_agents table skipped:', e.message?.substring(0, 100));
    }
    // Seed AI agents (links to existing @Fazeela and @mrbeast accounts)
    try {
      const { seedAIAgents } = await import('./aiAgentService');
      await seedAIAgents();
    } catch (e: any) {
      console.error('[moderation] AI seed skipped:', e.message?.substring(0, 100));
    }

    // Seed additional commenter agents (idempotent upsert — Phase 1: @sameer)
    try {
      const { seedCommenterAgents } = await import('./aiAgentService');
      await seedCommenterAgents();
    } catch (e: any) {
      console.error('[moderation] AI commenter seed skipped:', e.message?.substring(0, 100));
    }

    console.log('[moderation] schema ensured and verified');
  } catch (err) {
    console.error('[moderation] schema ensure failed', err);
    throw err;
  }
}

/**
 * Ensure the message_restricted_until column exists on users (safe ADD only).
 */
let restrictColReady = false;
export async function ensureRestrictColumn() {
  if (restrictColReady) return;
  try {
    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'message_restricted_until'`
    );
    if (Number(rows[0]?.c ?? 0) === 0) {
      await prisma.$executeRawUnsafe(`ALTER TABLE users ADD COLUMN message_restricted_until DATETIME(3) NULL`);
      console.log('[moderation] added message_restricted_until column');
    }
  } catch (err) { console.error('[moderation] restrict column ensure failed', err); }
  restrictColReady = true;
}

/**
 * Background moderation for a freshly posted comment.
 * Deletes the comment + notifies the author if toxic. Never throws.
 */
export async function moderateComment(commentId: string): Promise<void> {
  try {
    const comment = await prisma.comment.findUnique({
      where: { id: commentId },
      select: { id: true, userId: true, content: true, postId: true },
    });
    if (!comment || !comment.content?.trim()) return; // already deleted or empty

    const { toxic, reason, severity } = await checkCommentToxicity(comment.content);
    if (!toxic) return;

    // Low severity (mild/borderline): don't delete, don't warn — too many false positives
    // (user-ordered 2026-10-16: normal comments were getting warnings)
    if (severity === 'low') {
      console.log(`[moderation] low-severity comment ${commentId} ignored (no action)`);
      return;
    }

    await sleep(removalDelayMs()); // delayed removal (5-10 min), not instant
    // Re-check existence (user may have deleted it meanwhile)
    const stillThere = await prisma.comment.findUnique({ where: { id: commentId }, select: { id: true } });
    if (!stillThere) return;

    await prisma.comment.delete({ where: { id: commentId } });
    console.log(`[moderation] deleted toxic comment ${commentId} (${reason})`);

    await ensureCommentRemovedType();
    await createNotification({
      userId: comment.userId,
      type: 'comment_removed',
      postId: comment.postId ?? undefined, // tap -> opens the post it was on
      detail: reason, // stored + shown in-app and in push
      reaction: reason, // push text slot
    });
  } catch (err) {
    console.error('[moderation] moderateComment failed', err);
  }
}

/**
 * Background moderation for a Messenger chat message.
 * Policy: abusive language -> escalating messaging restrictions with reason.
 *   1st offense: 48 hours messaging ban
 *   2nd offense: 7 days messaging ban
 *   serious (high severity): 30 days messaging ban
 *   very serious (critical: threats, child safety, extremism): permanent account suspension
 * On restriction: all of the offender's conversations are deleted.
 * Never throws.
 */
export async function moderateChatMessage(messageId: string): Promise<void> {
  try {
    const msg = await prisma.message.findUnique({
      where: { id: messageId },
      select: { id: true, senderId: true, content: true, conversationId: true },
    });
    if (!msg || !msg.content?.trim()) return;

    const { toxic, reason, severity } = await checkCommentToxicity(msg.content);
    if (!toxic) return;

    // Low severity (mild/borderline, incl. emojis): no action — too many false positives
    // (user-ordered 2026-10-16: emojis should never be spam in Messenger)
    if (severity === 'low') {
      console.log(`[moderation] low-severity chat message ${messageId} ignored (no action)`);
      return;
    }
    const sev: Severity = severity || 'medium';

    await ensureRestrictColumn();

    // Count prior strikes (last 180 days)
    const since = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
    const priorStrikes = await prisma.chatAbuseStrike.count({
      where: { userId: msg.senderId, createdAt: { gte: since } },
    });

    // Decide action
    let action: string;
    let restrictedUntil: Date | null = null;
    let suspend = false;
    if (sev === 'critical') {
      action = 'SUSPENDED';
      suspend = true;
    } else if (sev === 'high') {
      action = 'RESTRICTED_30D';
      restrictedUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    } else if (priorStrikes === 0) {
      action = 'RESTRICTED_48H';
      restrictedUntil = new Date(Date.now() + 48 * 60 * 60 * 1000);
    } else if (priorStrikes === 1) {
      action = 'RESTRICTED_7D';
      restrictedUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    } else {
      action = 'RESTRICTED_30D';
      restrictedUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    }

    // Record the strike
    await prisma.chatAbuseStrike.create({
      data: { userId: msg.senderId, severity: sev, reason: reason || 'abusive language', messageId: msg.id, action },
    });

    // Apply restriction or suspension
    if (suspend) {
      await prisma.user.update({ where: { id: msg.senderId }, data: { accountStatus: 'suspended' } });
    } else {
      await prisma.user.update({ where: { id: msg.senderId }, data: { messageRestrictedUntil: restrictedUntil } });
    }
    console.log(`[moderation] chat abuse: ${action} for user ${msg.senderId} (${reason}, severity=${sev})`);

    // Delete all conversations of the offender
    const participations = await prisma.conversationParticipant.findMany({
      where: { userId: msg.senderId },
      select: { conversationId: true },
    });
    for (const part of participations) {
      try {
        await prisma.conversation.delete({ where: { id: part.conversationId } });
      } catch { /* already gone */ }
    }
    console.log(`[moderation] deleted ${participations.length} conversations for ${msg.senderId}`);

    // Notify with reason
    await ensureCommentRemovedType();
    const reasonText = reason || 'abusive language';
    const detail = suspend
      ? `permanent account suspension for ${reasonText}`
      : `messaging restricted for ${action === 'RESTRICTED_48H' ? '48 hours' : action === 'RESTRICTED_7D' ? '7 days' : '30 days'} for ${reasonText}`;
    await createNotification({
      userId: msg.senderId,
      type: 'messaging_restricted' as any,
      detail,
      reaction: detail,
    });
  } catch (err) {
    console.error('[moderation] moderateChatMessage failed', err);
  }
}
