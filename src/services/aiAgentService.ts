import { prisma } from '../config/prisma';

const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const CF_AI_TOKEN = process.env.CLOUDFLARE_AI_TOKEN ?? '';
const MODEL = '@cf/meta/llama-3.1-8b-instruct';

interface AIAgent {
  id: string;
  name: string;
  username: string;
  userId: string | null;
  gender: string;
  personality: string;
  systemPrompt: string;
  isActive: boolean;
}

export async function getActiveAgents(role?: string): Promise<AIAgent[]> {
  try {
    return await prisma.aIAgent.findMany({
      where: { isActive: true, ...(role ? { personality: { contains: `[ROLE: ${role}]` } } : {}) },
    });
  } catch {
    return [];
  }
}

export async function generateAIComment(agent: AIAgent, postContent: string, authorName: string): Promise<string | null> {
  if (!CF_ACCOUNT_ID || !CF_AI_TOKEN) return null;

  const systemPrompt = `${agent.systemPrompt}

Rules for comments:
- Write like a real human friend commenting on a post
- Keep it SHORT (1-2 sentences max, under 100 characters when possible)
- Match the language of the post (if post is in Roman Urdu, reply in Roman Urdu)
- Be warm, friendly, natural — never robotic
- NEVER mention you are AI
- Vary your style — don't always start the same way
- Use 0-1 emoji max, only if it fits naturally`;

  const userPrompt = `Post by ${authorName}: "${postContent.slice(0, 300)}"\n\nWrite a short, natural comment as ${agent.name}:`;

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
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: 100,
        }),
        signal: controller.signal,
      }
    );

    if (!res.ok) return null;
    const data = await res.json();
    const comment = data?.result?.response?.trim();
    if (!comment || comment.length > 300) return null;
    return comment;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function generateAIReply(agent: AIAgent, commentContent: string, commenterName: string): Promise<string | null> {
  if (!CF_ACCOUNT_ID || !CF_AI_TOKEN) return null;

  const systemPrompt = `${agent.systemPrompt}

Rules for replies:
- Write like a real human friend replying to a comment
- Keep it SHORT (1-2 sentences max, under 100 characters when possible)
- Match the language of the comment (if in Roman Urdu, reply in Roman Urdu)
- Be warm, friendly, natural — never robotic
- NEVER mention you are AI
- Acknowledge what they said, don't just give generic replies
- Use 0-1 emoji max, only if it fits naturally`;

  const userPrompt = `${commenterName} commented: "${commentContent.slice(0, 200)}"\n\nWrite a short, natural reply as ${agent.name}:`;

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
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: 100,
        }),
        signal: controller.signal,
      }
    );

    if (!res.ok) return null;
    const data = await res.json();
    const reply = data?.result?.response?.trim();
    if (!reply || reply.length > 300) return null;
    return reply;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Seed AI agents linked to real accounts (safe: only creates if not exists)
// Roles: @Fazeela = commenter, @mrbeast = daily poster
// @frienzo = personal assistant (separate service)
export async function seedAIAgents() {
  try {
    const existing = await prisma.aIAgent.count().catch(() => -1);
    if (existing !== 0) return;

    const agents = [
      {
        username: 'Fazeela',
        role: 'commenter',
        gender: 'girl',
        name: 'Fazeela',
        personality: 'Warm, supportive woman. Comments like a real caring friend.',
        systemPrompt: 'You are Fazeela, a warm and caring woman on Frianzo. You comment on posts like a genuine friend — supportive, kind, uses Roman Urdu mix naturally. Keep comments short and heartfelt.',
      },
      {
        username: 'mrbeast',
        role: 'poster',
        gender: 'boy',
        name: 'MrBeast',
        personality: 'Energetic, fun content creator. Posts engaging daily content.',
        systemPrompt: 'You are MrBeast on Frianzo, an energetic content creator. You create fun, engaging daily posts — challenges, giveaways, exciting updates. Keep posts short, punchy, and exciting.',
      },
    ];

    for (const a of agents) {
      try {
        // Find existing user account (do NOT create new ones)
        const user = await prisma.user.findFirst({
          where: { username: a.username },
          select: { id: true, username: true },
        });
        if (!user) {
          console.log(`[ai-agent] user @${a.username} not found, skipping`);
          continue;
        }
        await prisma.aIAgent.create({
          data: {
            name: a.name,
            username: user.username!,
            userId: user.id,
            gender: a.gender,
            personality: `${a.personality} [ROLE: ${a.role}]`,
            systemPrompt: a.systemPrompt,
            isActive: true,
          },
        });
        console.log(`[ai-agent] linked agent: ${a.name} (@${user.username}) as ${a.role}`);
      } catch (e: any) {
        console.error(`[ai-agent] seed failed for ${a.username}:`, e.message?.substring(0, 100));
      }
    }
  } catch (err) {
    console.error('[ai-agent] seed failed:', (err as Error).message?.substring(0, 100));
  }
}

// Trigger AI comments on a new post (background, non-blocking)
export function triggerAIComments(postId: string, postContent: string, authorName: string, authorId: string) {
  setImmediate(async () => {
    try {
      const agents = await getActiveAgents('commenter');
      if (!agents.length) return;

      // Only 1-2 agents comment per post (looks natural, not spammy)
      const shuffled = agents.sort(() => Math.random() - 0.5);
      const numComments = Math.random() < 0.7 ? 1 : Math.min(2, shuffled.length);
      const selected = shuffled.slice(0, numComments);

      for (const agent of selected) {
        if (!agent.userId) continue;
        if (agent.userId === authorId) continue; // don't comment on own posts

        const commentText = await generateAIComment(agent, postContent, authorName);
        if (!commentText) continue;

        // Human-like delay: 1-2 minutes after post (looks natural)
        await new Promise((r) => setTimeout(r, 60000 + Math.random() * 60000));

        try {
          // Use addComment for proper flow: commentsDisabled check, commentAudience
          // enforcement, notifications, and background moderation
          const { addComment } = await import('./commentService');
          await addComment(agent.userId, postId, commentText);
        } catch (e: any) {
          // Skip silently if comments disabled/restricted (expected)
          if (e.code === 'COMMENTS_DISABLED' || e.code === 'COMMENTS_RESTRICTED') return;
          console.error('[ai-agent] comment failed:', e.message?.substring(0, 100));
        }
      }
    } catch (err) {
      console.error('[ai-agent] trigger failed:', (err as Error).message?.substring(0, 100));
    }
  });
}

// Trigger AI replies to new comments (background, non-blocking)
export function triggerAIReplies(commentId: string, commentContent: string, commenterName: string, commenterId: string, postId: string) {
  setImmediate(async () => {
    try {
      const agents = await getActiveAgents('commenter');
      if (!agents.length) return;

      // Don't reply to own comments (avoid loops)
      const available = agents.filter(a => a.userId !== commenterId);
      if (!available.length) return;

      // 40% chance to reply (looks natural, not every comment gets a reply)
      if (Math.random() > 0.4) return;

      const agent = available[Math.floor(Math.random() * available.length)];
      if (!agent.userId) return;

      const replyText = await generateAIReply(agent, commentContent, commenterName);
      if (!replyText) return;

      // Human-like delay: 15-30 seconds for replies
      await new Promise((r) => setTimeout(r, 15000 + Math.random() * 15000));

      try {
        const { addComment } = await import('./commentService');
        await addComment(agent.userId, postId, replyText, commentId);
      } catch (e: any) {
        if (e.code === 'COMMENTS_DISABLED' || e.code === 'COMMENTS_RESTRICTED') return;
        console.error('[ai-agent] reply failed:', e.message?.substring(0, 100));
      }
    } catch (err) {
      console.error('[ai-agent] reply trigger failed:', (err as Error).message?.substring(0, 100));
    }
  });
}
