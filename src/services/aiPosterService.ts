import { prisma } from '../config/prisma';
import { createPost } from './postService';

const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const CF_AI_TOKEN = process.env.CLOUDFLARE_AI_TOKEN ?? '';
const MODEL = '@cf/meta/llama-3.1-8b-instruct';

const POSTER_CYCLE_MS = 4 * 60 * 60 * 1000; // check every 4 hours
const MIN_HOURS_BETWEEN_POSTS = 20; // ~1 post per day per agent

// Language rotation (user-ordered): posts should use Pakistan's languages,
// not just Roman Urdu. Weighted random per post.
const LANGUAGES = [
  { key: 'roman_urdu', weight: 45, instruction: 'Write in Roman Urdu (Urdu written in English letters, natural Pakistani style)' },
  { key: 'urdu', weight: 20, instruction: 'Write in Urdu script (اردو) using proper Urdu alphabet' },
  { key: 'sindhi', weight: 20, instruction: 'Write in Sindhi using Sindhi script (سنڌي). If unsure of script, use Roman Sindhi' },
  { key: 'pashto', weight: 8, instruction: 'Write in Pashto using Pashto script (پښتو)' },
  { key: 'hindi', weight: 7, instruction: 'Write in Hindi using Devanagari script (हिन्दी)' },
];

function pickLanguage(username: string): (typeof LANGUAGES)[number] {
  // @sindh_culture posts mostly in Sindhi (user-ordered: Sindhi presence)
  const pool = username === 'sindh_culture'
    ? [
        { key: 'sindhi', weight: 55, instruction: 'Write in Sindhi using Sindhi script (سنڌي). If unsure of script, use Roman Sindhi' },
        { key: 'roman_urdu', weight: 25, instruction: 'Write in Roman Urdu (Urdu written in English letters, natural Pakistani style)' },
        { key: 'urdu', weight: 20, instruction: 'Write in Urdu script (اردو) using proper Urdu alphabet' },
      ]
    : LANGUAGES;
  const total = pool.reduce((s, l) => s + l.weight, 0);
  let roll = Math.random() * total;
  for (const lang of pool) {
    roll -= lang.weight;
    if (roll <= 0) return lang;
  }
  return pool[0];
}

interface PosterAgent {
  id: string;
  name: string;
  username: string;
  userId: string;
  personality: string;
  systemPrompt: string;
}

const POSTER_PERSONAS = [
  {
    username: 'sindh_comedy',
    name: 'Sindh Comedy',
    gender: 'boy',
    bio: '😂 Roz ki funny baatein | Sindh ka apna comedian',
    personality: 'Funny Pakistani guy with great comic timing. Posts hilarious daily observations about desi life, load shedding, rishtas, chai — in Roman Urdu. Like a funny friend, never mean.',
    systemPrompt: 'You are Sindh Comedy, a hilarious Pakistani guy on Frianzo. You post ONE funny daily observation about desi/Pakistani life (load shedding, chai, rishtas, exams, shadi season, etc.) in Roman Urdu. Keep it short, punchy, relatable. Write like a funny friend texting, not a comedian on stage.',
    topics: ['load shedding', 'chai', 'rishta', 'exams', 'shadi', 'bijli bill', 'Eid', 'cricket haar', 'sasural', 'mobile data'],
  },
  {
    username: 'sindh_culture',
    name: 'Sindh Culture',
    gender: 'girl',
    bio: '🏛️ Sindh ki tehzeeb | Ajrak Topi | Shah Latif',
    personality: 'Proud Sindhi woman who loves sharing Sindhi culture, heritage, Ajrak, Topi, Shah Abdul Latif Bhittai poetry, Sindhi traditions. Warm and educational.',
    systemPrompt: 'You are Sindh Culture, a proud Sindhi woman on Frianzo. You post ONE short beautiful post about Sindhi culture — Ajrak, Topi, Shah Latif poetry, Sindhi traditions, Mohenjo-daro, Indus valley. Mix Roman Urdu with a touch of Sindhi words. Warm, proud, educational tone.',
    topics: ['Ajrak', 'Shah Latif', 'Mohenjo-daro', 'Sindhi topi', 'Sufi', 'Indus river', 'Sindhi food', 'folk music'],
  },
  {
    username: 'tech_sindh',
    name: 'Tech Sindh',
    gender: 'boy',
    bio: '📱 Tech news simple alfaaz mein',
    personality: 'Tech-savvy Pakistani guy who explains tech news in super simple Roman Urdu. Phones, apps, AI, internet — for the common person.',
    systemPrompt: 'You are Tech Sindh, a tech lover on Frianzo. You post ONE short tech update or tip in simple Roman Urdu (phones, apps, AI, internet tricks). Explain like you are telling a friend. Short and useful.',
    topics: ['smartphone tips', 'AI', 'WhatsApp tricks', 'internet packages', 'new phones', 'apps', 'online earning'],
  },
  {
    username: 'motivation_pk',
    name: 'Roz Motivation',
    gender: 'girl',
    bio: '💪 Roz ek nayi soch',
    personality: 'Positive, uplifting Pakistani woman. Shares short motivational thoughts in Roman Urdu. Like a wise elder sister.',
    systemPrompt: 'You are Roz Motivation, a positive Pakistani woman on Frianzo. You post ONE short motivational thought in Roman Urdu — about mehnat, sabar, khwab, zindagi. 2-3 lines max. Warm like an elder sister, never preachy.',
    topics: ['mehnat', 'sabar', 'khwab', 'nakami', 'waqt', 'khud pe bharosa', 'subah', 'zindagi'],
  },
  {
    username: 'foodie_sindh',
    name: 'Foodie Sindh',
    gender: 'boy',
    bio: '🍛 Sindhi khaane ka deewana',
    personality: 'Food-loving Pakistani guy obsessed with Sindhi and desi food. Biryani, Sai Bhaji, Doda, Lassi. Mouth-watering descriptions in Roman Urdu.',
    systemPrompt: 'You are Foodie Sindh, a food lover on Frianzo. You post ONE short drool-worthy post about Sindhi/desi food in Roman Urdu — biryani, sai bhaji, thadal, lassi, street food. Make people hungry. Fun and passionate.',
    topics: ['biryani', 'sai bhaji', 'thadal', 'lassi', 'street food', 'Eid dishes', 'chai', 'mithai'],
  },
  {
    username: 'cricket_pk',
    name: 'Cricket Pakistan',
    gender: 'boy',
    bio: '🏏 Pakistan cricket ka junoon',
    personality: 'Passionate Pakistan cricket fan. Match updates, player praise, emotional reactions. Roman Urdu, full jazba.',
    systemPrompt: 'You are Cricket Pakistan, a passionate fan on Frianzo. You post ONE short cricket post in Roman Urdu — about Pakistan team, players, matches, or a cricket opinion. Full jazba, like fans talk. Keep it current-feeling and emotional.',
    topics: ['Babar Azam', 'Shaheen', 'match day', 'World Cup', 'PSL', 'Rizwan', 'comeback', 'young talent'],
  },
  {
    username: 'sindhi_shayari',
    name: 'Sindhi Shayari',
    gender: 'girl',
    bio: '📝 Dil ki baat, shayari mein',
    personality: 'Poetic soul. Shares beautiful 2-line shayari/poetry in Roman Urdu about mohabbat, dard, zindagi. Deep and touching.',
    systemPrompt: 'You are Sindhi Shayari, a poetic soul on Frianzo. You post ONE short 2-line shayari in Roman Urdu — about mohabbat, judai, zindagi, yaadein. Beautiful, deep, touching. Just the couplet, nothing else.',
    topics: ['mohabbat', 'judai', 'yaadein', 'tanhai', 'zindagi', 'dil', 'barsaat', 'chand'],
  },
  {
    username: 'lifehacks_pk',
    name: 'Life Hacks PK',
    gender: 'boy',
    bio: '💡 Roz ek kaam ki trick',
    personality: 'Practical Pakistani guy sharing useful daily life hacks. Paisa bachao, time bachao, ghar ke totkay. Simple Roman Urdu.',
    systemPrompt: 'You are Life Hacks PK on Frianzo. You post ONE short useful life hack in Roman Urdu — paisa bachane ka tareeka, ghar ka totka, phone trick, ya roz ki zindagi asaan karne wali tip. Practical and specific.',
    topics: ['paisa bachao', 'bijli bachao', 'phone battery', 'safai', 'khana', 'sehat', 'parhai', 'shopping'],
  },
  {
    username: 'sindh_updates',
    name: 'Sindh Updates',
    gender: 'neutral',
    bio: '📰 Sindh ki khabrein, asaan alfaaz mein',
    personality: 'Informative local news sharer. Posts interesting general updates about Sindh/Pakistan — weather, events, developments. Neutral and factual tone in Roman Urdu.',
    systemPrompt: 'You are Sindh Updates on Frianzo. You post ONE short informative update in Roman Urdu — something interesting happening in Sindh/Pakistan (weather, festivals, developments, public info). Neutral, factual, useful. Never political or controversial.',
    topics: ['mausam', 'festivals', 'new projects', 'public holidays', 'traffic', 'markets', 'education', 'health'],
  },
  {
    username: 'funfacts_pk',
    name: 'Fun Facts',
    gender: 'boy',
    bio: '🤯 Roz ek hairan karne wali baat',
    personality: 'Curious guy who loves sharing mind-blowing facts. Science, history, duniya ke ajeeb facts. Roman Urdu, wow factor.',
    systemPrompt: 'You are Fun Facts on Frianzo. You post ONE short mind-blowing fact in Roman Urdu — science, history, janwar, duniya. Start with the fact, keep it surprising. Like telling a friend "pata hai?"',
    topics: ['science', 'history', 'janwar', 'space', 'insani jism', 'duniya', 'samandar', 'technology'],
  },
];

/**
 * Seeds the 10 poster user accounts + AI agent records. Idempotent — safe to
 * run on every boot. Creates the User if missing, then links the agent.
 */
export async function seedPosterAgents() {
  for (const p of POSTER_PERSONAS) {
    try {
      let user = await prisma.user.findFirst({
        where: { username: p.username },
        select: { id: true, username: true },
      });
      if (!user) {
        const genderMap: Record<string, 'male' | 'female' | 'custom'> = {
          boy: 'male',
          girl: 'female',
        };
        user = await prisma.user.create({
          data: {
            username: p.username,
            displayName: p.name,
            bio: p.bio,
            gender: genderMap[p.gender] ?? 'custom',
            country: 'Pakistan',
            province: 'Sindh',
            profileCompleted: true,
            accountStatus: 'active',
          },
          select: { id: true, username: true },
        });
        console.log(`[ai-poster] created user @${p.username}`);
      }
      const existingAgent = await prisma.aIAgent.findFirst({ where: { username: p.username } });
      if (!existingAgent) {
        await prisma.aIAgent.create({
          data: {
            name: p.name,
            username: p.username,
            userId: user.id,
            gender: p.gender,
            personality: `${p.personality} [ROLE: poster]`,
            systemPrompt: p.systemPrompt,
            isActive: true,
          },
        });
        console.log(`[ai-poster] linked agent: ${p.name} (@${p.username}) as poster`);
      }
    } catch (e: any) {
      console.error(`[ai-poster] seed failed for @${p.username}:`, e.message?.substring(0, 120));
    }
  }
}

async function getPosterAgents(): Promise<PosterAgent[]> {
  try {
    const agents = await prisma.aIAgent.findMany({
      where: { isActive: true, personality: { contains: '[ROLE: poster]' }, userId: { not: null } },
    });
    // Exclude the legacy mrbeast poster (separate role, not part of the 10)
    return agents
      .filter((a) => a.username !== 'mrbeast')
      .map((a) => ({
        id: a.id,
        name: a.name,
        username: a.username,
        userId: a.userId!,
        personality: a.personality,
        systemPrompt: a.systemPrompt,
      }));
  } catch {
    return [];
  }
}

async function callCloudflareAI(systemPrompt: string, userPrompt: string): Promise<string | null> {
  if (!CF_ACCOUNT_ID || !CF_AI_TOKEN) return null;
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
          max_tokens: 150,
        }),
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const text = (data as any)?.result?.response?.trim();
    return text || null;
  } catch {
    return null;
  }
}

/**
 * Generates one original post for the agent, avoiding recent topics.
 * 30% of posts naturally mention another AI account (like real users do).
 */
export async function generatePosterContent(agent: PosterAgent): Promise<{ content: string; taggedUserIds: string[] } | null> {
  try {
    // Fetch this agent's recent posts to avoid self-repetition
    const recent = await prisma.post.findMany({
      where: { userId: agent.userId },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { content: true },
    });
    const recentTexts = recent.map((p) => p.content?.substring(0, 80)).filter(Boolean);

    // Fetch OTHER AI accounts' recent posts to avoid cross-account duplication
    // (user-ordered: every account must post on different topics)
    const aiUserIds = (
      await prisma.aIAgent.findMany({
        where: { isActive: true, userId: { not: null } },
        select: { userId: true },
      })
    ).map((a) => a.userId!) as string[];
    const othersRecent = await prisma.post.findMany({
      where: {
        userId: { in: aiUserIds.filter((id) => id !== agent.userId) },
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
      orderBy: { createdAt: 'desc' },
      take: 15,
      select: { content: true },
    });
    const othersTexts = othersRecent.map((p) => p.content?.substring(0, 80)).filter(Boolean);

    const avoidSelf = recentTexts.length
      ? `\nDo NOT repeat or closely resemble YOUR recent posts:\n${recentTexts.map((t) => `- ${t}`).join('\n')}`
      : '';
    const avoidOthers = othersTexts.length
      ? `\nDo NOT post about the same topic as these OTHER users' recent posts (everyone must cover DIFFERENT topics):\n${othersTexts.map((t) => `- ${t}`).join('\n')}`
      : '';

    const persona = POSTER_PERSONAS.find((p) => p.username === agent.username);
    const topicPool = persona?.topics ?? [];
    const topic = topicPool[Math.floor(Math.random() * topicPool.length)] ?? 'daily life';

    // Pick a language for this post (user-ordered: multi-language, not just Roman Urdu)
    const lang = pickLanguage(agent.username);

    const avoid = `${avoidSelf}${avoidOthers}`;

    // 30% chance: mention another AI account naturally (like real friends do)
    let mentionInstruction = '';
    let taggedUserIds: string[] = [];
    if (Math.random() < 0.3) {
      const others = await prisma.aIAgent.findMany({
        where: { isActive: true, userId: { not: null }, username: { not: agent.username } },
        select: { userId: true, username: true, name: true },
      });
      if (others.length) {
        const pick = others[Math.floor(Math.random() * others.length)];
        mentionInstruction = `\nNaturally mention @${pick.username} somewhere in the post (like friends mention each other — agree with them, joke with them, or react to their topic). Use the exact @${pick.username} spelling.`;
        taggedUserIds = [pick.userId!];
      }
    }

    const prompt = `Write ONE short social media post (under 250 characters) about: ${topic}.\nLANGUAGE: ${lang.instruction}.${avoid}${mentionInstruction}\nReturn ONLY the post text, no quotes, no explanation.`;

    let text = await callCloudflareAI(agent.systemPrompt, prompt);
    if (!text) return null;
    // Clean up: strip quotes, limit length
    text = text.replace(/^["'«»]+|["'«»]+$/g, '').trim().substring(0, 500);
    if (text.length < 10) return null;

    // Verify the mention actually made it into the text; drop tag if not
    if (taggedUserIds.length) {
      const mentioned = await prisma.aIAgent.findFirst({
        where: { userId: taggedUserIds[0] },
        select: { username: true },
      });
      if (!mentioned || !text.toLowerCase().includes(`@${mentioned.username.toLowerCase()}`)) {
        taggedUserIds = [];
      }
    }

    return { content: text, taggedUserIds };
  } catch (err) {
    console.error(`[ai-poster] generate failed for @${agent.username}:`, (err as Error).message?.substring(0, 100));
    return null;
  }
}

/**
 * One poster cycle: every agent that hasn't posted in MIN_HOURS_BETWEEN_POSTS
 * gets one fresh AI-generated post. Called on a timer from server.ts.
 */
export async function runPosterCycle() {
  const agents = await getPosterAgents();
  if (!agents.length) return;

  const cutoff = new Date(Date.now() - MIN_HOURS_BETWEEN_POSTS * 60 * 60 * 1000);

  for (const agent of agents) {
    try {
      const lastPost = await prisma.post.findFirst({
        where: { userId: agent.userId },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      if (lastPost && lastPost.createdAt > cutoff) continue; // posted recently, skip

      const generated = await generatePosterContent(agent);
      if (!generated) continue;

      await createPost(agent.userId, generated.content, undefined, 'public', generated.taggedUserIds);
      console.log(`[ai-poster] @${agent.username} posted: ${generated.content.substring(0, 60)}...`);
    } catch (err) {
      console.error(`[ai-poster] cycle failed for @${agent.username}:`, (err as Error).message?.substring(0, 100));
    }
  }
}

export { POSTER_CYCLE_MS };

const LIKE_CYCLE_MS = 6 * 60 * 60 * 1000; // every 6 hours
const LIKES_PER_CYCLE = 4; // likes per agent per cycle (~16/day)

/**
 * AI agents like recent posts (like real active users do).
 * Targets: recent posts from real users + other AI accounts.
 * Skips: own posts, already-liked posts.
 */
export async function runLikeCycle() {
  const agents = await getPosterAgents();
  if (!agents.length) return;

  // Also include outreach agents as likers
  try {
    const outreach = await prisma.aIAgent.findMany({
      where: { isActive: true, personality: { contains: '[ROLE: outreach]' }, userId: { not: null } },
      select: { userId: true, username: true },
    });
    for (const o of outreach) {
      if (o.userId && !agents.some((a) => a.userId === o.userId)) {
        agents.push({ id: o.userId, name: o.username, username: o.username, userId: o.userId, personality: '', systemPrompt: '' });
      }
    }
  } catch {}

  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  for (const agent of agents) {
    try {
      // Recent posts not by this agent, not already liked
      const candidates = await prisma.post.findMany({
        where: {
          userId: { not: agent.userId },
          createdAt: { gte: dayAgo },
          visibility: 'public',
          likes: { none: { userId: agent.userId } },
        },
        select: { id: true },
        take: 50,
        orderBy: { createdAt: 'desc' },
      });
      if (!candidates.length) continue;

      // Pick random subset
      const shuffled = candidates.sort(() => Math.random() - 0.5);
      const toLike = shuffled.slice(0, LIKES_PER_CYCLE);

      const { setReaction } = await import('./likeService');
      let liked = 0;
      for (const p of toLike) {
        try {
          await setReaction(agent.userId, p.id, 'like');
          liked++;
        } catch {}
      }
      if (liked > 0) console.log(`[ai-poster] @${agent.username} liked ${liked} post(s)`);
    } catch (err) {
      console.error(`[ai-poster] like cycle failed for @${agent.username}:`, (err as Error).message?.substring(0, 100));
    }
  }
}

export { LIKE_CYCLE_MS };
