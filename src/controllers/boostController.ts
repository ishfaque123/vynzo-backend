import { Request, Response, NextFunction } from 'express';
import { PostBoostStatus } from '@prisma/client';
import { prisma } from '../config/prisma';
import { sendSuccess } from '../utils/ApiResponse';
import { ApiError } from '../middleware/errorHandler';
import { createBoostRequest, getBoostConfigForUser, getMyBoosts, boostDisplayStatus } from '../services/boostService';
import { createNotification } from '../services/notificationService';

// User-facing handlers are thin wrappers over boostService; the admin
// queue handlers mirror listAdminVerificationRequests /
// reviewAdminVerificationRequest in adminController.ts (same pagination
// helpers, same guarded pending-only transition).

export async function getBoostConfigHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const config = await getBoostConfigForUser(req.user!.id);
    sendSuccess(res, config);
  } catch (err) { next(err); }
}

export async function createBoostRequestHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const boost = await createBoostRequest(req.user!.id, req.body ?? {});
    sendSuccess(res, { boost }, 201);
  } catch (err) { next(err); }
}

export async function getMyBoostsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const boosts = await getMyBoosts(req.user!.id);
    sendSuccess(res, { boosts });
  } catch (err) { next(err); }
}

const PAGE_SIZE_MAX = 50;

function pageValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1;
}

function limitValue(value: unknown) {
  const parsed = Number(value);
  return Math.min(PAGE_SIZE_MAX, Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 20);
}

function skipFor(page: number, limit: number) {
  return (page - 1) * limit;
}

export async function listAdminBoostRequests(req: Request, res: Response, next: NextFunction) {
  try {
    const page = pageValue(req.query.page);
    const limit = limitValue(req.query.limit);
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const rawStatus = typeof req.query.status === 'string' ? req.query.status : '';
    const status = rawStatus === 'pending' || rawStatus === 'approved' || rawStatus === 'rejected' || rawStatus === 'expired'
      ? rawStatus as PostBoostStatus
      : undefined;

    const where = {
      ...(status ? { status } : {}),
      ...(search
        ? {
            OR: [
              { transactionId: { contains: search } },
              { user: { username: { contains: search } } },
              { user: { displayName: { contains: search } } },
              { user: { email: { contains: search } } },
              { post: { content: { contains: search } } },
              { reel: { caption: { contains: search } } },
            ],
          }
        : {}),
    };

    const [total, boosts] = await Promise.all([
      prisma.postBoost.count({ where }),
      prisma.postBoost.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: skipFor(page, limit),
        take: limit,
        select: {
          id: true,
          contentType: true,
          purpose: true,
          planDays: true,
          amountPkr: true,
          paymentMethod: true,
          transactionId: true,
          screenshotUrl: true,
          status: true,
          adminNote: true,
          reviewedBy: true,
          reviewedAt: true,
          startsAt: true,
          endsAt: true,
          createdAt: true,
          user: {
            select: {
              id: true,
              username: true,
              displayName: true,
              email: true,
              profilePictureUrl: true,
              country: true,
            },
          },
          post: {
            select: {
              id: true,
              content: true,
              imageUrl: true,
              createdAt: true,
            },
          },
          reel: {
            select: {
              id: true,
              caption: true,
              thumbnailUrl: true,
              videoUrl: true,
              createdAt: true,
            },
          },
        },
      }),
    ]);

    const enriched = boosts.map((boost) => ({ ...boost, status: boostDisplayStatus(boost) }));

    return sendSuccess(res, { requests: enriched, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    next(err);
  }
}

export async function reviewAdminBoostRequest(req: Request, res: Response, next: NextFunction) {
  try {
    const requestId = req.params.requestId;
    const action = req.body?.action;
    const adminNote = typeof req.body?.adminNote === 'string' ? req.body.adminNote.trim() : '';

    if (action !== 'approve' && action !== 'reject') {
      throw new ApiError(400, 'INVALID_BOOST_ACTION', 'Action must be approve or reject.');
    }
    if (adminNote.length > 1000) {
      throw new ApiError(400, 'BOOST_NOTE_TOO_LONG', 'Admin note must be 1000 characters or fewer.');
    }

    const boost = await prisma.postBoost.findUnique({
      where: { id: requestId },
      select: { id: true, userId: true, postId: true, reelId: true, planDays: true, status: true },
    });
    if (!boost) throw new ApiError(404, 'BOOST_REQUEST_NOT_FOUND', 'Boost request not found.');
    if (boost.status !== PostBoostStatus.pending) {
      throw new ApiError(409, 'BOOST_REQUEST_ALREADY_REVIEWED', 'This boost request has already been reviewed.');
    }

    const now = new Date();
    const nextStatus: PostBoostStatus = action === 'approve'
      ? PostBoostStatus.approved
      : PostBoostStatus.rejected;
    // Approval starts the boost immediately and runs it for the plan's
    // days; the feed only picks it up while now is inside [startsAt, endsAt).
    const startsAt = action === 'approve' ? now : null;
    const endsAt = action === 'approve' ? new Date(now.getTime() + boost.planDays * 24 * 60 * 60 * 1000) : null;

    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.postBoost.updateMany({
        where: { id: boost.id, status: PostBoostStatus.pending },
        data: {
          status: nextStatus,
          adminNote: adminNote || null,
          reviewedBy: req.user!.id,
          reviewedAt: now,
          startsAt,
          endsAt,
        },
      });

      if (result.count !== 1) {
        throw new ApiError(409, 'BOOST_REQUEST_ALREADY_REVIEWED', 'This boost request has already been reviewed.');
      }

      return tx.postBoost.findUnique({
        where: { id: boost.id },
        select: {
          id: true,
          contentType: true,
          postId: true,
          reelId: true,
          userId: true,
          purpose: true,
          planDays: true,
          amountPkr: true,
          paymentMethod: true,
          transactionId: true,
          screenshotUrl: true,
          status: true,
          adminNote: true,
          reviewedBy: true,
          reviewedAt: true,
          startsAt: true,
          endsAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    });

    // Owner order 2026-11-18: the user is notified when their boost is
    // approved (approve only — no reject notification). Mirrors the
    // verification review in adminController.ts: createNotification is
    // called AFTER the review transaction has committed, so a
    // notification failure can never roll back or break the review.
    // `reaction` carries the content type for the push text only (the
    // notificationService pattern for display-only push data).
    if (action === 'approve' && updated) {
      await createNotification({
        userId: updated.userId,
        type: 'boost_approved',
        postId: updated.postId ?? undefined,
        reelId: updated.reelId ?? undefined,
        reaction: updated.contentType,
      });
    }

    return sendSuccess(res, { boost: updated ? { ...updated, status: boostDisplayStatus(updated) } : updated, action });
  } catch (err) {
    next(err);
  }
}
