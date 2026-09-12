import { prisma } from '../config/prisma';

export async function recordPing(userId: string) {
  await prisma.usagePing.create({ data: { userId } });
  return { recorded: true };
}

export async function getPings(userId: string, from: Date, to: Date) {
  const pings = await prisma.usagePing.findMany({
    where: { userId, pingedAt: { gte: from, lt: to } },
    select: { pingedAt: true },
    orderBy: { pingedAt: 'asc' },
  });
  return pings.map((p) => p.pingedAt);
}
