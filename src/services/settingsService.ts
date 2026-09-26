import { prisma } from '../config/prisma';

const DEFAULTS = {
  seoTitle: 'Frianzo',
  seoDescription: 'Frianzo — share your moments',
  seoKeywords: '',
};

export async function getSiteSettings() {
  const row = await prisma.siteSettings.findUnique({ where: { id: 1 } });
  if (row) return row;
  return prisma.siteSettings.create({ data: { id: 1, ...DEFAULTS } });
}

export async function updateSeoSettings(data: { seoTitle?: string; seoDescription?: string; seoKeywords?: string }) {
  return prisma.siteSettings.upsert({
    where: { id: 1 },
    create: { id: 1, ...DEFAULTS, ...data },
    update: data,
  });
}
