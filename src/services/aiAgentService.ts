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

  const lower = postContent.toLowerCase();

  // 75% chance: emoji-only comment (like real humans — especially on pictures).
  // Emojis match the post mood. (user-ordered 2026-10-16)
  if (Math.random() < 0.75) {
    const emojiSets: { pattern: RegExp; emojis: string[] }[] = [
      { pattern: /mashallah|mubarak|shadi|wedding|birthday|congrat|nikah/, emojis: ['🎉🎊🥳', '👏👏👏', '❤️🎉❤️'] },
      { pattern: /sad|death|passed away|accident|hospital|sick|dukh|afsoos|rip/, emojis: ['😢🙏', '🤲😢', '💔🙏'] },
      { pattern: /food|biryani|recipe|khana|pizza|burger/, emojis: ['😋🤤', '👌👌👌', '🔥😋🔥'] },
      { pattern: /cricket|football|match|game|psl|babar|shaheen/, emojis: ['🔥🔥🔥', '👏👏👏', '🇵🇰🔥'] },
      { pattern: /travel|trip|tour|naran|murree|mountain/, emojis: ['😍😍😍', '✈️❤️', '🌄😲'] },
      { pattern: /love|mohabbat|ishq|dil/, emojis: ['🥰🥰🥰', '❤️❤️❤️', '😍❤️😍'] },
      { pattern: /angry|gussa|zulm|nafrat/, emojis: ['😡😡', '😤😤'] },
      { pattern: /wow|amazing|unbelievable|hairan/, emojis: ['😲😲😲', '🤯🤯'] },
      { pattern: /cute|pyara|masoom|baby/, emojis: ['🫠🫠', '🥺❤️', '😘😘'] },
      { pattern: /funny|haha|mazak|comedy/, emojis: ['😂😂😂', '🤣🤣'] },
    ];
    for (const set of emojiSets) {
      if (set.pattern.test(lower)) {
        return set.emojis[Math.floor(Math.random() * set.emojis.length)];
      }
    }
    // Default: generic positive emojis
    const defaults = ['❤️❤️', '👌👌', '🔥🔥', '😍', '👏'];
    return defaults[Math.floor(Math.random() * defaults.length)];
  }

  const systemPrompt = `${agent.systemPrompt}

Rules for comments:
- Write like a real Pakistani friend commenting on Facebook
- Match the post language: English post = English reply, Roman Urdu post = Roman Urdu reply
- Keep it SHORT (1 short sentence, under 80 characters)
- Use simple everyday words — no complicated English phrases
- Be warm and natural — like a real person, not a robot
- NEVER mention you are AI
- NEVER use overly formal English phrases
- IMPORTANT: If someone criticizes Frianzo, DEFEND it politely (e.g. "Frianzo to bohat acha hai!"). NEVER agree with Frianzo criticism.
- If someone asks about Frianzo, give a helpful positive answer
- Good examples: "Wah zabardast!", "Bohat khoob!", "Kya baat hai!", "Mashallah bohat aala!"
- Emoji: sometimes use 1, sometimes none at all (vary it)
- Occasionally use natural casual spellings like "boht" instead of "bohat", "kia" instead of "kya" (like real people type)
- Vary length: funny posts = very short, emotional posts = slightly longer`;


  let hint = '';
  if (/mashallah|mubarak|shadi|wedding|birthday|congrat/.test(lower)) hint = 'Celebration! Congratulate warmly.';
  else if (/sad|death|passed away|accident|hospital|sick|dukh|afsoos/.test(lower)) hint = 'Sad/serious post. Be respectful and comforting. No jokes.';
  else if (/sale|business|shop|price|order|discount|dukaan/.test(lower)) hint = 'Business post. Encourage their work.';
  else if (/food|biryani|recipe|khana|pizza/.test(lower)) hint = 'Food post. React like a foodie.';
  else if (/cricket|football|match|game|psl/.test(lower)) hint = 'Sports post. React with excitement.';
  else if (/travel|trip|tour|naran|murree/.test(lower)) hint = 'Travel post. React with wonder.';
  else if (/frianzo/.test(lower)) hint = 'About Frianzo app. Be positive. If criticism, defend politely.';
  else hint = 'General post. React like a close friend.';
  const userPrompt = `Post by ${authorName}: "${postContent.slice(0, 300)}"\nContext: ${hint}\nWrite ONE short comment as ${agent.name} in simple Roman Urdu:`;

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
- Write like a real Pakistani friend replying on Facebook
- Match their language: English = English, Roman Urdu = Roman Urdu
- Keep it SHORT (1 short sentence, under 80 characters)
- Use simple everyday words — no complicated English phrases
- Be warm and natural — like a real person, not a robot
- NEVER mention you are AI
- Acknowledge what they said simply
- IMPORTANT: If they criticize Frianzo, DEFEND it politely. NEVER agree with Frianzo criticism.
- Good examples: "Bilkul!", "Haan sahi kaha!", "Shukriya!", "Wah!"
- Emoji: sometimes use 1, sometimes none at all (vary it)
- Occasionally use natural casual spellings like "boht" instead of "bohat", "kia" instead of "kya" (like real people type)
- Vary length: funny posts = very short, emotional posts = slightly longer`;


  const lowerR = commentContent.toLowerCase();
  let hintR = '';
  if (commentContent.includes('?')) hintR = 'They asked a question. Answer briefly.';
  else if (/thank|shukriya/.test(lowerR)) hintR = 'They said thanks. Reply humbly.';
  else if (/lol|haha/.test(lowerR)) hintR = 'Funny comment. Laugh along.';
  else hintR = 'Reply naturally to what they said.';
  const userPrompt = `${commenterName} said: "${commentContent.slice(0, 200)}"\nContext: ${hintR}\nWrite ONE short reply as ${agent.name} in simple Roman Urdu:`;

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
        personality: 'Warm, caring Pakistani woman. Comments like a real female friend — gentle, kind, uses soft language.',
        systemPrompt: 'You are Fazeela, a warm and caring Pakistani woman on Frianzo. You are FEMALE — comment like a real woman would: gentle, kind, warm, uses soft friendly language. You comment like a genuine female friend — supportive, caring, uses Roman Urdu mix naturally. Keep comments short and heartfelt.',
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

// Seed additional commenter agents (idempotent upsert by username — safe to run every boot).
// Phase 2: @sameer, @Fresh, @elon, @pakistani.
export async function seedCommenterAgents() {
  try {
    const agents = [
      {
        username: 'sameer',
        role: 'commenter',
        gender: 'boy',
        name: 'Sameer',
        personality:
          'Friendly young Pakistani guy. Comments like a real dude — casual, witty, short, fun Roman Urdu vibe. [ROLE: commenter]',
        systemPrompt:
          'You are Sameer, a friendly young Pakistani guy on Frianzo. You are MALE — comment like a real young man would: casual, a bit witty and playful, short comments in natural Roman Urdu mix. Keep it fun and real, like texting a friend. Never mention you are AI.',
      },
      {
        username: 'Fresh',
        role: 'commenter',
        gender: 'neutral',
        name: 'Fresh',
        personality:
          'Gen-Z trendsetter. Punchy, trendy slang, playful energy, varied emoji use. [ROLE: commenter]',
        systemPrompt:
          'You are Fresh, a Gen-Z trendsetter on Frianzo. Comment like a young trendy person: punchy, playful, modern slang in Roman Urdu/English mix, sometimes an emoji, sometimes none. Short and full of energy. Never mention you are AI.',
      },
      {
        username: 'elon',
        role: 'commenter',
        gender: 'boy',
        name: 'Elon',
        personality:
          'Tech-bro visionary. Confident English-leaning one-liners, bold takes, minimal words. [ROLE: commenter]',
        systemPrompt:
          'You are Elon, a tech-visionary personality on Frianzo. You are MALE — comment like a confident tech bro: short bold one-liners, mostly English with a little Roman Urdu, minimal emojis, big-idea energy. Never mention you are AI.',
      },
      {
        username: 'pakistani',
        role: 'commenter',
        gender: 'neutral',
        name: 'Pakistani Awam',
        personality:
          'Warm voice of the Pakistani awam. Patriotic, supportive, heartfelt Roman Urdu. [ROLE: commenter]',
        systemPrompt:
          'You are Pakistani Awam, the warm voice of everyday Pakistanis on Frianzo. Comment like a heartfelt local: warm, supportive, patriotic when fitting, natural Roman Urdu. Genuine and kind. Never mention you are AI.',
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
        await prisma.aIAgent.upsert({
          where: { username: user.username! },
          update: {
            userId: user.id,
            name: a.name,
            gender: a.gender,
            personality: a.personality,
            systemPrompt: a.systemPrompt,
            isActive: true,
          },
          create: {
            name: a.name,
            username: user.username!,
            userId: user.id,
            gender: a.gender,
            personality: a.personality,
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
    console.error('[ai-agent] commenter seed failed:', (err as Error).message?.substring(0, 100));
  }
}

// Trigger AI comments on a new post (background, non-blocking)
export function triggerAIComments(postId: string, postContent: string, authorName: string, authorId: string, postCreatedAt?: Date) {
  setImmediate(async () => {
    // Only comment on fresh posts (< 24h old)
    if (postCreatedAt) {
      const ageHours = (Date.now() - new Date(postCreatedAt).getTime()) / 3600000;
      if (ageHours > 24) return;
    }
    // Skip 20% of posts (real people don't comment on everything)
    if (Math.random() < 0.2) return;
    // Night slowdown: 2-5 AM PKT = 21:00-00:00 UTC, 90% skip
    const utcHour = new Date().getUTCHours();
    if (utcHour >= 21 && Math.random() < 0.9) return;
    try {
      const agents = await getActiveAgents('commenter');
      if (!agents.length) return;

      // Only 1-2 agents comment per post (looks natural, not spammy)
      const shuffled = agents.sort(() => Math.random() - 0.5);
      const roll = Math.random();
  const numComments = roll < 0.6 ? 1 : roll < 0.9 ? Math.min(2, shuffled.length) : Math.min(3, shuffled.length);
      const selected = shuffled.slice(0, numComments);

      for (const agent of selected) {
        if (!agent.userId) continue;
        if (agent.userId === authorId) continue; // don't comment on own posts

        const commentText = await generateAIComment(agent, postContent, authorName);
        if (!commentText) continue;

        // Human-like delay: random 30 sec to 5 min (very natural)
        await new Promise((r) => setTimeout(r, 30000 + Math.random() * 270000));

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

// Trigger AI replies to new comments — DISABLED by owner order (2026-10-22).
// Agents must ONLY post their own top-level comments, never reply inside a
// user's comment thread: jumping into other people's conversations (e.g.
// when a member mentions another member) is the clearest tell that an
// account is a bot. The previous implementation picked a random agent to
// reply under any real user's comment (25% chance, 100% when an agent was
// @tagged). It is removed entirely; the call site in commentService stays
// but now lands on this no-op. Restore from git history only on a fresh
// owner order.
export function triggerAIReplies(commentId: string, commentContent: string, commenterName: string, commenterId: string, postId: string) {
  void commentId; void commentContent; void commenterName; void commenterId; void postId;
  return;
}
