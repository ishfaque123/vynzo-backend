import { prisma } from '../config/prisma';
import { ApiError } from '../middleware/errorHandler';
import { isEitherBlocked } from './blockService';

const authorSelect = { id: true, username: true, displayName: true, profilePictureUrl: true };

export const STICKER_TYPES = ['poll', 'question', 'countdown', 'link'] as const;

export interface StickerInput {
  type: string;
  posX?: number;
  posY?: number;
  data: Record<string, any>;
}

function validateStickerData(type: string, data: Record<string, any>) {
  if (type === 'poll') {
    const question = String(data.question || '').trim().slice(0, 100);
    const options = Array.isArray(data.options)
      ? data.options.map((o: any) => String(o || '').trim().slice(0, 40)).filter(Boolean).slice(0, 4)
      : [];
    if (!question) throw new ApiError(400, 'INVALID_STICKER', 'Poll needs a question.');
    if (options.length < 2) throw new ApiError(400, 'INVALID_STICKER', 'Poll needs at least 2 options.');
    return { question, options };
  }
  if (type === 'question') {
    const prompt = String(data.prompt || '').trim().slice(0, 100);
    if (!prompt) throw new ApiError(400, 'INVALID_STICKER', 'Question sticker needs a prompt.');
    return { prompt };
  }
  if (type === 'countdown') {
    const title = String(data.title || '').trim().slice(0, 60);
    const targetAt = new Date(data.targetAt);
    if (!title) throw new ApiError(400, 'INVALID_STICKER', 'Countdown needs a title.');
    if (isNaN(targetAt.getTime()) || targetAt.getTime() <= Date.now()) {
      throw new ApiError(400, 'INVALID_STICKER', 'Countdown needs a future date.');
    }
    return { title, targetAt: targetAt.toISOString() };
  }
  if (type === 'link') {
    let url = String(data.url || '').trim().slice(0, 500);
    if (!url) throw new ApiError(400, 'INVALID_STICKER', 'Link sticker needs a URL.');
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    try {
      new URL(url);
    } catch {
      throw new ApiError(400, 'INVALID_STICKER', 'Invalid URL.');
    }
    const label = String(data.label || '').trim().slice(0, 40) || new URL(url).hostname;
    return { url, label };
  }
  throw new ApiError(400, 'INVALID_STICKER', 'Unknown sticker type.');
}

/** Validate + normalize sticker inputs for createStatus. */
export function prepareStickers(inputs: StickerInput[] | undefined) {
  if (!inputs || !Array.isArray(inputs)) return [];
  if (inputs.length > 5) throw new ApiError(400, 'TOO_MANY_STICKERS', 'Maximum 5 stickers per status.');
  return inputs.map((s) => {
    const type = String(s.type || '').toLowerCase();
    if (!(STICKER_TYPES as readonly string[]).includes(type)) {
      throw new ApiError(400, 'INVALID_STICKER', 'Unknown sticker type.');
    }
    const posX = Math.min(100, Math.max(0, Number(s.posX ?? 50) || 50));
    const posY = Math.min(100, Math.max(0, Number(s.posY ?? 50) || 50));
    return { type, posX, posY, data: JSON.stringify(validateStickerData(type, s.data || {})) };
  });
}

function parseSticker(s: any) {
  let data: any = {};
  try {
    data = JSON.parse(s.data);
  } catch {}
  return { id: s.id, type: s.type, posX: s.posX, posY: s.posY, data };
}

/** Attach stickers to a status (called from createStatus). */
export async function createStickers(statusId: string, inputs: StickerInput[]) {
  const prepared = prepareStickers(inputs);
  if (!prepared.length) return [];
  await prisma.statusSticker.createMany({ data: prepared.map((p) => ({ ...p, statusId })) });
  return prepared;
}

/** Get stickers for a status, with per-user vote state and owner-only aggregates. */
export async function getStickers(statusId: string, viewerId: string, isOwner: boolean) {
  const stickers = await prisma.statusSticker.findMany({
    where: { statusId },
    include: {
      votes: { select: { userId: true, optionIndex: true } },
      answers: { select: { id: true, userId: true, text: true, createdAt: true, user: { select: authorSelect } } },
    },
    orderBy: { createdAt: 'asc' },
  });
  return stickers.map((s) => {
    const base = parseSticker(s);
    const myVote = s.votes.find((v) => v.userId === viewerId);
    if (s.type === 'poll') {
      const counts = base.data.options.map((_: any, i: number) => s.votes.filter((v) => v.optionIndex === i).length);
      const total = s.votes.length;
      return {
        ...base,
        myVote: myVote?.optionIndex ?? null,
        // Non-owners only see results after voting (Instagram pattern).
        results: isOwner || myVote ? { counts, total } : null,
      };
    }
    if (s.type === 'question') {
      return {
        ...base,
        myAnswer: s.answers.find((a) => a.userId === viewerId)?.text ?? null,
        // Only the owner sees answers.
        answers: isOwner ? s.answers : undefined,
        answerCount: s.answers.length,
      };
    }
    return base;
  });
}

async function assertCanInteract(userId: string, stickerId: string) {
  const sticker = await prisma.statusSticker.findUnique({
    where: { id: stickerId },
    include: { status: { select: { id: true, userId: true, expiresAt: true } } },
  });
  if (!sticker) throw new ApiError(404, 'STICKER_NOT_FOUND', 'Sticker not found.');
  if (sticker.status.expiresAt < new Date()) throw new ApiError(410, 'STATUS_EXPIRED', 'This story has expired.');
  if (sticker.status.userId === userId) throw new ApiError(400, 'OWN_STICKER', 'You cannot interact with your own sticker.');
  const blocked = await isEitherBlocked(userId, sticker.status.userId);
  if (blocked) throw new ApiError(403, 'BLOCKED', 'Cannot interact with this sticker.');
  return sticker;
}

/** Vote on a poll sticker (one vote per user; re-vote changes it). */
export async function votePoll(userId: string, stickerId: string, optionIndex: number) {
  const sticker = await assertCanInteract(userId, stickerId);
  if (sticker.type !== 'poll') throw new ApiError(400, 'NOT_A_POLL', 'This sticker is not a poll.');
  let data: any = {};
  try {
    data = JSON.parse(sticker.data);
  } catch {}
  const optionCount = Array.isArray(data.options) ? data.options.length : 0;
  if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= optionCount) {
    throw new ApiError(400, 'INVALID_OPTION', 'Invalid poll option.');
  }
  await prisma.stickerVote.upsert({
    where: { stickerId_userId: { stickerId, userId } },
    update: { optionIndex },
    create: { stickerId, userId, optionIndex },
  });
  return { voted: true, optionIndex };
}

/** Answer a question sticker (one answer per user; re-answer replaces it). */
export async function answerQuestion(userId: string, stickerId: string, text: string) {
  const sticker = await assertCanInteract(userId, stickerId);
  if (sticker.type !== 'question') throw new ApiError(400, 'NOT_A_QUESTION', 'This sticker is not a question.');
  const clean = String(text || '').trim().slice(0, 300);
  if (!clean) throw new ApiError(400, 'EMPTY_ANSWER', 'Answer cannot be empty.');
  const existing = await prisma.stickerAnswer.findFirst({ where: { stickerId, userId } });
  if (existing) {
    await prisma.stickerAnswer.update({ where: { id: existing.id }, data: { text: clean } });
  } else {
    await prisma.stickerAnswer.create({ data: { stickerId, userId, text: clean } });
  }
  return { answered: true };
}
