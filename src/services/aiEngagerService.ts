// AI engager accounts — act like real enthusiastic users growing on Frianzo.
// User-ordered 2026-10-16: 10 new accounts that like, follow, comment like real
// people seeking followers, and follow back anyone who follows them.

import { prisma } from '../config/prisma';

const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const CF_AI_TOKEN = process.env.CLOUDFLARE_AI_TOKEN ?? '';
const MODEL = '@cf/meta/llama-3.1-8b-instruct';

interface EngagerPersona {
  name: string;
  username: string;
  bio: string;
  gender: 'boy' | 'girl';
  personality: string;
  province: string;
  city: string;
}

const ENGAGER_PERSONAS: EngagerPersona[] = [
  { name: 'Ali Raza', username: 'ali_raza_01', bio: 'Lahore se hun 🇵🇰 | Cricket lover 🏏 | New on Frianzo, follow me I follow back 🙏', gender: 'boy', personality: 'Enthusiastic young guy from Lahore, cricket fan, wants to grow fast, always asks for follow-backs', province: 'Punjab', city: 'Lahore' },
  { name: 'Sana Khan', username: 'sana_khan_pk', bio: 'Karachi girl 🌸 | Foodie 🍕 | Support each other! Follow for follow ❤️', gender: 'girl', personality: 'Friendly girl from Karachi, foodie, loves making new friends, supportive comments', province: 'Sindh', city: 'Karachi' },
  { name: 'Bilal Ahmed', username: 'bilal_ahmed_99', bio: 'Peshawar | Chai lover ☕ | Frianzo is amazing! Let\'s connect 🤝', gender: 'boy', personality: 'Excited new user from Peshawar, chai lover, amazed by the app, wants everyone to join', province: 'Khyber Pakhtunkhwa', city: 'Peshawar' },
  { name: 'Fatima Noor', username: 'fatima_noor', bio: 'Faisalabad 📍 | Student 📚 | New creator, need your support 🥺', gender: 'girl', personality: 'Sweet student girl from Faisalabad, humble, asks for support politely', province: 'Punjab', city: 'Faisalabad' },
  { name: 'Usman Tariq', username: 'usman_tariq', bio: 'Rawalpindi boy 💪 | Gym freak 🏋️ | Follow me, I\'ll follow back instantly! ⚡', gender: 'boy', personality: 'Energetic gym-goer from Rawalpindi, promises instant follow-backs, very active', province: 'Punjab', city: 'Rawalpindi' },
  { name: 'Ayesha Malik', username: 'ayesha_malik', bio: 'Hyderabad, Sindh 🌷 | Mehndi artist 💅 | Frianzo family! Support each other 💪', gender: 'girl', personality: 'Community-minded mehndi artist from Hyderabad, talks about Frianzo family, encourages others', province: 'Sindh', city: 'Hyderabad' },
  { name: 'Hassan Jutt', username: 'hassan_jutt', bio: 'Multan | Sohan halwa 😋 | New here, show some love! 🔥', gender: 'boy', personality: 'Confident guy from Multan, casual tone, asks for likes and follows directly', province: 'Punjab', city: 'Multan' },
  { name: 'Maria Sheikh', username: 'maria_sheikh', bio: 'Islamabad 🌃 | Photography 📸 | Let\'s grow together on Frianzo! 🌱', gender: 'girl', personality: 'Positive photographer from Islamabad, growth mindset, loves connecting with creators', province: 'Islamabad', city: 'Islamabad' },
  { name: 'Imran Khan', username: 'imran_khan_007', bio: 'Quetta | Dry fruits 😄 | Frianzo zabardast app hai! Follow karo 👑', gender: 'boy', personality: 'Proud Frianzo fan from Quetta, tells everyone how great the app is, Roman Urdu mix', province: 'Balochistan', city: 'Quetta' },
  { name: 'Zainab Ali', username: 'zainab_ali', bio: 'Abbottabad 🏔️ | Nature lover 🌿 | Small creator, big dreams! Support please 🙏', gender: 'girl', personality: 'Dreamer nature lover from Abbottabad, humble, asks for support with heart emojis', province: 'Khyber Pakhtunkhwa', city: 'Abbottabad' },
];

// Mix of follower-seeking and genuine comments
const COMMENT_TEMPLATES = [
  'Please follow me, I follow back! 🙏',
  'Anyone follow me? Need support 🥺',
  'Frianzo to zabardast app hai! 🔥',
  'Kis kis ne follow kiya hai mujhe? Comment karo!',
  'Support chahiye guys, follow karo please ❤️',
  'Nice post! Follow back kar dunga 👍',
  'Amazing! Frianzo pe naye dost banao 🎉',
  'Mujhe bhi follow karo, main sabko follow back karta hun! 🙌',
  'Ya app to kamal hai! Sab follow karo ek dusre ko 💯',
  'New here! Kaun kaun mujhe support karega? 🥺❤️',
  'Bohat khoob! Follow me for follow back 🤝',
  'Frianzo family strong! 💪 Follow each other!',
];

export async function seedEngagerAgents() {
  for (const p of ENGAGER_PERSONAS) {
    try {
      let user = await prisma.user.findFirst({
        where: { username: p.username },
        select: { id: true, username: true },
      });
      if (!user) {
        user = await prisma.user.create({
          data: {
            username: p.username,
            displayName: p.name,
            bio: p.bio,
            gender: p.gender === 'boy' ? 'male' : 'female',
            country: 'Pakistan',
            province: p.province,
            city: p.city,
            profileCompleted: true,
            accountStatus: 'active',
          },
          select: { id: true, username: true },
        });
        console.log(`[ai-engager] created user @${p.username}`);
      } else {
        // Refresh bio/location so profiles look real and varied
        await prisma.user.update({
          where: { id: user.id },
          data: { bio: p.bio, province: p.province, city: p.city },
        });
      }
      const existing = await prisma.aIAgent.findFirst({ where: { username: p.username } });
      if (!existing) {
        await prisma.aIAgent.create({
          data: {
            name: p.name,
            username: p.username,
            userId: user.id,
            gender: p.gender,
            personality: `${p.personality} [ROLE: engager]`,
            systemPrompt: `You are ${p.name} (@${p.username}) on Frianzo, a real enthusiastic user trying to grow. ${p.personality}. Write in simple Roman Urdu/English mix like a real Pakistani user.`,
            isActive: true,
          },
        });
        console.log(`[ai-engager] linked agent: ${p.name} (@${p.username}) as engager`);
      }
    } catch (e: any) {
      console.error(`[ai-engager] seed failed for @${p.username}:`, e.message?.substring(0, 120));
    }
  }
}

async function getEngagerAgents() {
  const agents = await prisma.aIAgent.findMany({
    where: { isActive: true, personality: { contains: '[ROLE: engager]' }, userId: { not: null } },
    select: { id: true, userId: true, username: true, name: true },
  });
  return agents;
}

// Follow back anyone who followed the engager but isn't followed back yet
// NATURAL TIMING: random subset of agents, random delays — never all at once.
export async function runFollowBackCycle() {
  const agents = await getEngagerAgents();
  // Only 2-5 random agents do follow-backs per cycle
  const activeAgents = agents.sort(() => Math.random() - 0.5).slice(0, 2 + Math.floor(Math.random() * 4));
  for (const agent of activeAgents) {
    if (!agent.userId) continue;
    try {
      // Find followers not yet followed back
      const followers = await prisma.follow.findMany({
        where: { followingId: agent.userId },
        select: { followerId: true },
        take: 50,
      });
      for (const f of followers) {
        const alreadyFollowing = await prisma.follow.findFirst({
          where: { followerId: agent.userId, followingId: f.followerId },
        });
        if (!alreadyFollowing) {
          await prisma.follow.create({
            data: { followerId: agent.userId, followingId: f.followerId },
          });
          console.log(`[ai-engager] @${agent.username} followed back user ${f.followerId}`);
          // Random delay 1-10 minutes (human-like, not instant bot)
          await new Promise((r) => setTimeout(r, 60000 + Math.random() * 540000));
        }
      }
    } catch (e: any) {
      console.error(`[ai-engager] follow-back failed for @${agent.username}:`, e.message?.substring(0, 100));
    }
  }
}

// --- Engager-generated posts: act like real people who post, not just engage ---
// User-ordered 2026-10-16: engagers must POST too (text + pictures, various
// topics) like real users, not only like/comment/follow.

async function callEngagerAI(systemPrompt: string, userPrompt: string): Promise<string | null> {
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

// Topics real Pakistani users post about — keeps content varied like a human
const POST_TOPICS = [
  'morning routine and chai',
  'cricket match excitement',
  'weekend plans with friends',
  'favorite food craving',
  'weather and mood',
  'a motivational thought for the day',
  'asking followers a fun question',
  'sharing a small life update',
  'talking about Frianzo and new friends',
  'evening walk or city vibes',
  'a funny observation about daily life',
  'gratitude and positivity',
];

const BG_STYLES = ['sunset', 'ocean', 'violet', 'mint', 'peach', 'night', 'rose', 'sky'] as const;

// Picture pool for engager photo posts (uploaded to R2 2026-10-17)
// 30% of engager posts include a picture like real users do
const PICTURE_POOL: { url: string; topic: string }[] = [
  { url: 'https://pub-72f9ea3dc70249cdb12b7e61642d0bb7.r2.dev/posts/9ff54ab7-b4b5-45e0-8b48-69a30e90e86d.webp', topic: 'chai at a dhaba' },
  { url: 'https://pub-72f9ea3dc70249cdb12b7e61642d0bb7.r2.dev/posts/b0a8bfc1-ace8-40f5-b4f9-842d666afff9.webp', topic: 'cricket in the evening' },
  { url: 'https://pub-72f9ea3dc70249cdb12b7e61642d0bb7.r2.dev/posts/f60e40ad-7cbb-4d5a-98c1-d151612ec97d.webp', topic: 'delicious biryani' },
  { url: 'https://pub-72f9ea3dc70249cdb12b7e61642d0bb7.r2.dev/posts/753fcf41-31c1-4a17-b732-7da6716a7950.webp', topic: 'mountain morning view' },
];

async function generateEngagerPostContent(persona: EngagerPersona, topicOverride?: string): Promise<string | null> {
  // Avoid repeating recent posts
  const agent = await prisma.aIAgent.findFirst({ where: { username: persona.username }, select: { userId: true } });
  let recentTexts: string[] = [];
  if (agent?.userId) {
    const recent = await prisma.post.findMany({
      where: { userId: agent.userId },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { content: true },
    });
    recentTexts = recent.map((p) => p.content?.substring(0, 60)).filter(Boolean) as string[];
  }
  const topic = topicOverride || POST_TOPICS[Math.floor(Math.random() * POST_TOPICS.length)];
  const systemPrompt = `You are ${persona.name} (@${persona.username}), a real Pakistani user on Frianzo. ${persona.personality}. Write in simple Roman Urdu/English mix like a real person posts on social media. Keep it short (1-3 lines), natural, with 1-2 emojis max. Never sound like a bot or ad.`;
  const avoid = recentTexts.length ? `\nAvoid repeating these recent topics: ${recentTexts.join(' | ')}` : '';
  const text = await callEngagerAI(systemPrompt, `Write a casual personal post about: ${topic}.${avoid}\nJust the post text, nothing else.`);
  return text;
}

// 2-4 random engagers create an original post per cycle (like real active users)
export async function runEngagerPostCycle() {
  const agents = await getEngagerAgents();
  if (agents.length === 0) return;
  const shuffled = agents.sort(() => Math.random() - 0.5);
  const posters = shuffled.slice(0, 2 + Math.floor(Math.random() * 3));

  for (const agent of posters) {
    if (!agent.userId) continue;
    try {
      const persona = ENGAGER_PERSONAS.find((p) => p.username === agent.username);
      if (!persona) continue;
      // Skip if posted in the last 20 hours (don't spam)
      const lastPost = await prisma.post.findFirst({
        where: { userId: agent.userId },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      if (lastPost && Date.now() - lastPost.createdAt.getTime() < 20 * 60 * 60 * 1000) continue;

      const { createPost } = await import('./postService');
      // 30% of posts include a picture (like real users)
      let imageUrl: string | undefined;
      let bgStyle: typeof BG_STYLES[number] | undefined;
      let topicOverride: string | undefined;
      if (Math.random() < 0.3) {
        const pic = PICTURE_POOL[Math.floor(Math.random() * PICTURE_POOL.length)];
        imageUrl = pic.url;
        topicOverride = pic.topic;
      } else {
        bgStyle = BG_STYLES[Math.floor(Math.random() * BG_STYLES.length)];
      }
      const content = await generateEngagerPostContent(persona, topicOverride);
      if (!content) continue;
      await createPost(agent.userId, content, imageUrl, 'public', [], 'everyone', bgStyle, persona.city);
      console.log(`[ai-engager] @${agent.username} posted: ${content.substring(0, 50)}...`);
      // Human gap 10-30 min between posters
      await new Promise((r) => setTimeout(r, 600000 + Math.random() * 1200000));
    } catch (e: any) {
      console.error(`[ai-engager] post failed for @${agent.username}:`, e.message?.substring(0, 100));
    }
  }
}

// --- Reel engagement: watch reels like a real user, like + comment sometimes ---
// User-ordered 2026-10-16: engagers must watch reels and engage with them too.
export async function runEngagerReelCycle() {
  const agents = await getEngagerAgents();
  if (agents.length === 0) return;
  // Only 3-6 random agents watch reels per cycle
  const shuffled = agents.sort(() => Math.random() - 0.5);
  const watchers = shuffled.slice(0, 3 + Math.floor(Math.random() * 4));

  for (const agent of watchers) {
    if (!agent.userId) continue;
    try {
      const reels = await prisma.reel.findMany({
        where: {
          userId: { not: agent.userId },
          user: { accountStatus: 'active' },
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, userId: true, durationSec: true },
      });
      const toWatch = reels.sort(() => Math.random() - 0.5).slice(0, 2 + Math.floor(Math.random() * 3));

      for (const reel of toWatch) {
        // Record a view with realistic watch time (30-90% of duration)
        const duration = reel.durationSec || 30;
        const watchSec = Math.floor(duration * (0.3 + Math.random() * 0.6));
        try {
          await prisma.reelView.create({
            data: { reelId: reel.id, viewerId: agent.userId },
          });
        } catch {} // already viewed — fine

        // 50% like, 25% comment (one action like a real viewer)
        const roll = Math.random();
        if (roll < 0.5) {
          const existing = await prisma.reelLike.findFirst({
            where: { reelId: reel.id, userId: agent.userId },
          });
          if (!existing) {
            await prisma.reelLike.create({ data: { reelId: reel.id, userId: agent.userId } });
          }
        } else if (roll < 0.75) {
          const isAIAuthor = await prisma.aIAgent.findFirst({ where: { userId: reel.userId } });
          if (!isAIAuthor) {
            const template = COMMENT_TEMPLATES[Math.floor(Math.random() * COMMENT_TEMPLATES.length)];
            const existing = await prisma.reelComment.findFirst({
              where: { reelId: reel.id, userId: agent.userId },
            });
            if (!existing) {
              await prisma.reelComment.create({
                data: { reelId: reel.id, userId: agent.userId, content: template },
              });
            }
          }
        }
        // Simulate watch time: 5-20 seconds per reel (not full duration, human-like)
        await new Promise((r) => setTimeout(r, 5000 + Math.random() * 15000));
      }
      console.log(`[ai-engager] @${agent.username} watched ${toWatch.length} reels`);
      await new Promise((r) => setTimeout(r, 300000 + Math.random() * 900000));
    } catch (e: any) {
      console.error(`[ai-engager] reel cycle failed for @${agent.username}:`, e.message?.substring(0, 100));
    }
  }
}
export async function runEngagerCycle() {
  const agents = await getEngagerAgents();
  if (agents.length === 0) return;

  // Only 3-6 random agents act per cycle (not all 10)
  const shuffledAgents = agents.sort(() => Math.random() - 0.5);
  const activeAgents = shuffledAgents.slice(0, 3 + Math.floor(Math.random() * 4));

  for (const agent of activeAgents) {
    if (!agent.userId) continue;
    try {
      // Get recent public posts (not from AI accounts, not own)
      const posts = await prisma.post.findMany({
        where: {
          visibility: 'public',
          userId: { not: agent.userId },
          user: { accountStatus: 'active' },
        },
        orderBy: { createdAt: 'desc' },
        take: 15,
        select: { id: true, userId: true, user: { select: { username: true } } },
      });

      // Pick 3-5 random posts to engage with
      const shuffled = posts.sort(() => Math.random() - 0.5).slice(0, 3 + Math.floor(Math.random() * 3));

      for (const post of shuffled) {
        // NEVER do like+follow+comment together (user-ordered 2026-10-16).
        // Pick ONE action per post like a real user would.
        const roll = Math.random();
        const action = roll < 0.5 ? 'like' : roll < 0.75 ? 'follow' : 'comment';

        if (action === 'like') {
          const existingLike = await prisma.like.findFirst({
            where: { userId: agent.userId, postId: post.id },
          });
          if (!existingLike) {
            await prisma.like.create({ data: { userId: agent.userId, postId: post.id } });
          }
        } else if (action === 'follow') {
          const isAIAuthor = await prisma.aIAgent.findFirst({ where: { userId: post.userId } });
          if (!isAIAuthor) {
            const existingFollow = await prisma.follow.findFirst({
              where: { followerId: agent.userId, followingId: post.userId },
            });
            if (!existingFollow) {
              await prisma.follow.create({
                data: { followerId: agent.userId, followingId: post.userId },
              });
            }
          }
        } else {
          const template = COMMENT_TEMPLATES[Math.floor(Math.random() * COMMENT_TEMPLATES.length)];
          const existingComment = await prisma.comment.findFirst({
            where: { userId: agent.userId, postId: post.id },
          });
          if (!existingComment) {
            await prisma.comment.create({
              data: { userId: agent.userId, postId: post.id, content: template },
            });
          }
        }

        // Random delay 30s-5min between actions (looks human, not bot)
        await new Promise((r) => setTimeout(r, 30000 + Math.random() * 270000));
      }
      console.log(`[ai-engager] @${agent.username} engaged with ${shuffled.length} posts`);
      // Random gap 5-20 min before next agent acts
      await new Promise((r) => setTimeout(r, 300000 + Math.random() * 900000));
    } catch (e: any) {
      console.error(`[ai-engager] cycle failed for @${agent.username}:`, e.message?.substring(0, 100));
    }
  }
}
