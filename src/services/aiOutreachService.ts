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
 * Welcome DM for new users (user-ordered 2026-10-16).
 * Sent once after profile setup completes, from @frianzo_dost.
 */
export async function sendWelcomeDM(newUserId: string) {
  try {
    const welcomer = await prisma.user.findUnique({
      where: { username: 'frianzo_dost' },
      select: { id: true, username: true },
    });
    if (!welcomer) return;

    const newUser = await prisma.user.findUnique({
      where: { id: newUserId },
      select: { displayName: true, username: true },
    });
    if (!newUser) return;

    const name = newUser.displayName || newUser.username || 'dost';
    const { getOrCreateConversation } = await import('./conversationService');

    // Don't send twice
    const convo = await getOrCreateConversation(welcomer.id, newUserId);
    const alreadySent = await prisma.message.findFirst({
      where: { conversationId: convo.id, senderId: welcomer.id },
      select: { id: true },
    });
    if (alreadySent) return;

    const welcomeText = `Assalam-o-Alaikum ${name}! 🎉\n\nFrianzo mein khush aamdeed! Main Frianzo Dost hun — yahan naye doston se milne mein madad karta hun.\n\nYahan tum posts, reels aur stories share kar sakte ho, doston se chat kar sakte ho, aur dilchasp logon ko follow kar sakte ho.\n\nKoi sawal ho to bas yahin likh do! 😊`;

    await prisma.message.create({
      data: {
        conversationId: convo.id,
        senderId: welcomer.id,
        content: welcomeText,
      },
    });
    await prisma.conversation.update({
      where: { id: convo.id },
      data: { updatedAt: new Date() },
    }).catch(() => {});

    console.log(`[ai-outreach] Welcome DM sent to @${newUser.username}`);
  } catch (err) {
    console.error('[ai-outreach] welcome DM failed:', (err as Error).message?.substring(0, 100));
  }
}

/**
 * Follow rules (user-ordered):
 * - ALL accounts on the app follow the official @frienzo account.
 * - All AI accounts follow each other (full mesh).
 * - The official @frienzo account follows NOBODY.
 * Idempotent — safe to run every boot.
 */
export async function seedOfficialFollows() {
  try {
    const official = await prisma.user.findFirst({
      where: { username: 'frienzo' },
      select: { id: true },
    });
    if (!official) {
      console.log('[ai-outreach] @frienzo not found, skipping follow seeding');
      return;
    }
    const agents = await prisma.aIAgent.findMany({
      where: { isActive: true, userId: { not: null } },
      select: { userId: true, username: true },
    });
    const aiUserIds = agents.map((a) => a.userId!).filter((id) => id !== official.id);

    // 1. @frienzo follows NOBODY — remove any @frienzo -> AI follows
    const badFollows = await prisma.follow.findMany({
      where: { followerId: official.id, followingId: { in: aiUserIds } },
      select: { followerId: true, followingId: true },
    });
    for (const f of badFollows) {
      await prisma.follow.delete({
        where: { followerId_followingId: { followerId: f.followerId, followingId: f.followingId } },
      }).catch(() => {});
    }
    if (badFollows.length > 0) console.log(`[ai-outreach] removed ${badFollows.length} @frienzo -> AI follow(s)`);

    // 2. EVERY account on the app follows @frienzo (batched, idempotent)
    let allFollowed = 0;
    const BATCH = 200;
    let cursor: string | undefined = undefined;
    while (true) {
      const users: { id: string }[] = await prisma.user.findMany({
        where: { accountStatus: 'active', id: { not: official.id } },
        select: { id: true },
        take: BATCH,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        orderBy: { id: 'asc' },
      });
      if (!users.length) break;
      for (const u of users) {
        const existing = await prisma.follow.findUnique({
          where: { followerId_followingId: { followerId: u.id, followingId: official.id } },
        });
        if (existing) continue;
        await prisma.follow.create({ data: { followerId: u.id, followingId: official.id } }).catch(() => {});
        allFollowed++;
      }
      cursor = users[users.length - 1].id;
      if (users.length < BATCH) break;
    }
    if (allFollowed > 0) console.log(`[ai-outreach] ${allFollowed} account(s) now follow @frienzo`);

    // 3. Every AI account follows every other AI account (full mesh)
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
