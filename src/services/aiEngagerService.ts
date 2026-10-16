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
export async function runFollowBackCycle() {
  const agents = await getEngagerAgents();
  for (const agent of agents) {
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
          // Small delay to look natural
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    } catch (e: any) {
      console.error(`[ai-engager] follow-back failed for @${agent.username}:`, e.message?.substring(0, 100));
    }
  }
}

// Like recent posts + follow their authors + drop follower-seeking comments
export async function runEngagerCycle() {
  const agents = await getEngagerAgents();
  if (agents.length === 0) return;

  for (const agent of agents) {
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
        // Like (skip if already liked)
        const existingLike = await prisma.like.findFirst({
          where: { userId: agent.userId, postId: post.id },
        });
        if (!existingLike) {
          await prisma.like.create({ data: { userId: agent.userId, postId: post.id } });
        }

        // Follow the author (skip if already following, skip AI accounts)
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

        // Comment (40% chance, follower-seeking style)
        if (Math.random() < 0.4) {
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

        await new Promise((r) => setTimeout(r, 3000));
      }
      console.log(`[ai-engager] @${agent.username} engaged with ${shuffled.length} posts`);
    } catch (e: any) {
      console.error(`[ai-engager] cycle failed for @${agent.username}:`, e.message?.substring(0, 100));
    }
  }
}
