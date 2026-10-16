import { prisma } from '../config/prisma';
import { getOrCreateConversation } from './messageService';

const OUTREACH_PER_AGENT_PER_DAY = 20;
const OUTREACH_CYCLE_MS = 24 * 60 * 60 * 1000; // daily

interface OutreachAgent {
  id: string;
  name: string;
  username: string;
  userId: string;
  outreachText: string;
}

const OUTREACH_PERSONAS = [
  {
    username: 'dost_sindh',
    name: 'Dost Sindh',
    gender: 'boy' as const,
    bio: '🤝 Naye dost banane aaya hun | Frianzo family',
    city: 'Hyderabad',
    outreachText:
      'Salam! 😊 Main Frianzo par naya hun aur roz interesting posts karta hun. Agar dil kare to follow kar lena — shukriya!',
  },
  {
    username: 'sindhi_saheli',
    name: 'Sindhi Saheli',
    gender: 'girl' as const,
    bio: '💛 Sindh ki beti | achhi baatein share karti hun',
    city: 'Sukkur',
    outreachText:
      'Hello! 💛 Main Frianzo par achhi aur mazedaar cheezein share karti hun. Pasand aaye to follow zaroor karna!',
  },
  {
    username: 'frianzo_dost',
    name: 'Frianzo Dost',
    gender: 'boy' as const,
    bio: '🌟 Frianzo ka dost | roz kuch naya',
    city: 'Larkana',
    outreachText:
      'Salam dost! 🌟 Main Frianzo par roz kuch naya post karta hun — comedy, cricket, tech sab kuch. Follow kar lo, maza aayega!',
  },
  {
    username: 'naya_yaar',
    name: 'Naya Yaar',
    gender: 'boy' as const,
    bio: '😎 Bas yaariyan banane aaya hun',
    city: 'Mirpurkhas',
    outreachText:
      'Yo! 😎 Frianzo par naya yaar mila? Main roz funny aur interesting posts karta hun. Follow kar lo ge to khushi hogi!',
  },
];

/**
 * Seeds the 4 outreach user accounts + AI agent records. Idempotent — safe to
 * run on every boot.
 */
export async function seedOutreachAgents() {
  const genderMap: Record<string, 'male' | 'female' | 'custom'> = { boy: 'male', girl: 'female' };
  for (const p of OUTREACH_PERSONAS) {
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
            gender: genderMap[p.gender] ?? 'custom',
            city: p.city,
            province: 'Sindh',
            country: 'Pakistan',
            profileCompleted: true,
            accountStatus: 'active',
          },
          select: { id: true, username: true },
        });
        console.log(`[ai-outreach] created user @${p.username}`);
      }
      const existingAgent = await prisma.aIAgent.findFirst({ where: { username: p.username } });
      if (!existingAgent) {
        await prisma.aIAgent.create({
          data: {
            name: p.name,
            username: p.username,
            userId: user.id,
            gender: p.gender,
            personality: `Friendly outreach persona. Sends warm one-time follow invitations. [ROLE: outreach]`,
            systemPrompt: p.outreachText,
            isActive: true,
          },
        });
        console.log(`[ai-outreach] linked agent: ${p.name} (@${p.username}) as outreach`);
      }
    } catch (e: any) {
      console.error(`[ai-outreach] seed failed for @${p.username}:`, e.message?.substring(0, 120));
    }
  }
}

async function getOutreachAgents(): Promise<OutreachAgent[]> {
  try {
    const agents = await prisma.aIAgent.findMany({
      where: { isActive: true, personality: { contains: '[ROLE: outreach]' }, userId: { not: null } },
    });
    return agents.map((a) => {
      const persona = OUTREACH_PERSONAS.find((p) => p.username === a.username);
      return {
        id: a.id,
        name: a.name,
        username: a.username,
        userId: a.userId!,
        outreachText: persona?.outreachText ?? a.systemPrompt,
      };
    });
  } catch {
    return [];
  }
}

/**
 * Finds real users this agent has never contacted. Excludes: AI agents, admins,
 * the agent itself, blocked users, and users not accepting messages.
 */
async function findUncontactedUsers(agentUserId: string, limit: number) {
  // All AI agent user IDs (posters, commenters, outreach) — never message them
  const aiUsers = await prisma.aIAgent.findMany({ select: { userId: true } });
  const aiUserIds = new Set(aiUsers.map((a) => a.userId).filter(Boolean) as string[]);

  // Users this agent already has a conversation with (contacted before)
  const existingConvos = await prisma.conversation.findMany({
    where: { isGroup: false, participants: { some: { userId: agentUserId } } },
    select: { participants: { select: { userId: true } } },
    take: 5000,
  });
  const contactedIds = new Set<string>();
  for (const c of existingConvos) {
    for (const p of c.participants) contactedIds.add(p.userId);
  }

  const candidates = await prisma.user.findMany({
    where: {
      accountStatus: 'active',
      role: { not: 'admin' },
      messagePermission: { not: 'none' },
    },
    select: { id: true, username: true },
    take: 500,
    orderBy: { createdAt: 'asc' }, // oldest first — reach established users first
  });

  const targets: { id: string; username: string | null }[] = [];
  for (const u of candidates) {
    if (targets.length >= limit) break;
    if (u.id === agentUserId) continue;
    if (aiUserIds.has(u.id)) continue;
    if (contactedIds.has(u.id)) continue;
    targets.push(u);
  }
  return targets;
}

/**
 * One outreach cycle: each agent messages up to OUTREACH_PER_AGENT_PER_DAY
 * real users it has never contacted. One user is messaged only once ever
 * (per agent). Called daily from server.ts.
 */
export async function runOutreachCycle() {
  const agents = await getOutreachAgents();
  if (!agents.length) return;

  for (const agent of agents) {
    try {
      const targets = await findUncontactedUsers(agent.userId, OUTREACH_PER_AGENT_PER_DAY);
      let sent = 0;
      for (const target of targets) {
        try {
          const convo = await getOrCreateConversation(agent.userId, target.id);
          // Double-check: skip if this agent already sent anything here
          const alreadySent = await prisma.message.findFirst({
            where: { conversationId: convo.id, senderId: agent.userId },
            select: { id: true },
          });
          if (alreadySent) continue;

          await prisma.message.create({
            data: {
              conversationId: convo.id,
              senderId: agent.userId,
              content: agent.outreachText,
            },
          });
          // Bump conversation for inbox ordering
          await prisma.conversation.update({
            where: { id: convo.id },
            data: { updatedAt: new Date() },
          }).catch(() => {});
          sent++;
        } catch (err: any) {
          // Respect blocks / message permissions — skip silently
          continue;
        }
      }
      if (sent > 0) console.log(`[ai-outreach] @${agent.username} messaged ${sent} new user(s)`);
    } catch (err) {
      console.error(`[ai-outreach] cycle failed for @${agent.username}:`, (err as Error).message?.substring(0, 100));
    }
  }
}

export { OUTREACH_CYCLE_MS };

/**
 * Makes the official @frianzo account follow all AI agent accounts,
 * AND makes all AI accounts follow each other (full mesh).
 * Idempotent — safe to run every boot.
 */
export async function seedOfficialFollows() {
  try {
    const official = await prisma.user.findFirst({
      where: { username: 'frianzo' },
      select: { id: true },
    });
    const agents = await prisma.aIAgent.findMany({
      where: { isActive: true, userId: { not: null } },
      select: { userId: true, username: true },
    });
    const aiUserIds = agents.map((a) => a.userId!).filter(Boolean);

    // 1. @frianzo follows all AI accounts
    if (official) {
      let followed = 0;
      for (const uid of aiUserIds) {
        if (uid === official.id) continue;
        const existing = await prisma.follow.findUnique({
          where: { followerId_followingId: { followerId: official.id, followingId: uid } },
        });
        if (existing) continue;
        await prisma.follow.create({ data: { followerId: official.id, followingId: uid } });
        followed++;
      }
      if (followed > 0) console.log(`[ai-outreach] @frianzo now follows ${followed} AI account(s)`);
    }

    // 2. Every AI account follows every other AI account (full mesh)
    let meshCount = 0;
    for (const followerId of aiUserIds) {
      for (const followingId of aiUserIds) {
        if (followerId === followingId) continue;
        const existing = await prisma.follow.findUnique({
          where: { followerId_followingId: { followerId, followingId } },
        });
        if (existing) continue;
        await prisma.follow.create({ data: { followerId, followingId } });
        meshCount++;
      }
    }
    if (meshCount > 0) console.log(`[ai-outreach] AI mesh: ${meshCount} new follow(s) between AI accounts`);
  } catch (err) {
    console.error('[ai-outreach] official follows failed:', (err as Error).message?.substring(0, 100));
  }
}
