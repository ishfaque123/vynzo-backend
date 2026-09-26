import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/prisma';
import { AccountStatus, VerificationRequestStatus } from '@prisma/client';
import { sendSuccess } from '../utils/ApiResponse';
import { ApiError } from '../middleware/errorHandler';
import { createNotification } from '../services/notificationService';

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

function normalizeStatus(value: unknown): AccountStatus | undefined {
  if (value === 'active') return AccountStatus.active;
  if (value === 'suspended') return AccountStatus.suspended;
  if (value === 'deactivated') return AccountStatus.deactivated;
  return undefined;
}

export async function getAdminOverview(_req: Request, res: Response, next: NextFunction) {
  try {
    const [
      totalUsers,
      activeUsers,
      suspendedUsers,
      deactivatedUsers,
      totalPosts,
      totalComments,
      totalReels,
      postReports,
      userReports,
      commentReports,
      reelCommentReports,
      recentUsers,
      recentReports,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { accountStatus: 'active' } }),
      prisma.user.count({ where: { accountStatus: 'suspended' } }),
      prisma.user.count({ where: { accountStatus: 'deactivated' } }),
      prisma.post.count(),
      prisma.comment.count(),
      prisma.reel.count(),
      prisma.report.count(),
      prisma.userReport.count(),
      prisma.commentReport.count(),
      prisma.reelCommentReport.count(),
      prisma.user.findMany({
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: {
          id: true,
          username: true,
          displayName: true,
          email: true,
          role: true,
          accountStatus: true,
          profilePictureUrl: true,
          createdAt: true,
          lastActiveAt: true,
        },
      }),
      prisma.report.findMany({
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: {
          id: true,
          reason: true,
          details: true,
          createdAt: true,
          post: { select: { id: true, content: true } },
          reporter: { select: { id: true, username: true, displayName: true } },
        },
      }),
    ]);

    return sendSuccess(res, {
      counts: {
        totalUsers,
        activeUsers,
        suspendedUsers,
        deactivatedUsers,
        totalPosts,
        totalComments,
        totalReels,
        totalReports: postReports + userReports + commentReports + reelCommentReports,
        postReports,
        userReports,
        commentReports,
        reelCommentReports,
      },
      recentUsers,
      recentReports,
    });
  } catch (err) {
    next(err);
  }
}

export async function listAdminUsers(req: Request, res: Response, next: NextFunction) {
  try {
    const page = pageValue(req.query.page);
    const limit = limitValue(req.query.limit);
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const status = normalizeStatus(req.query.status);

    const where = {
      ...(status ? { accountStatus: status } : {}),
      ...(search
        ? {
            OR: [
              { username: { contains: search } },
              { displayName: { contains: search } },
              { email: { contains: search } },
            ],
          }
        : {}),
    };

    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: skipFor(page, limit),
        take: limit,
        select: {
          id: true,
          username: true,
          displayName: true,
          email: true,
          googleId: true,
          role: true,
          accountStatus: true,
          isVerified: true,
          verifiedAt: true,
          profileCompleted: true,
          profilePictureUrl: true,
          createdAt: true,
          updatedAt: true,
          lastActiveAt: true,
          _count: {
            select: {
              posts: true,
              comments: true,
              followers: true,
              following: true,
              accountSessions: true,
              reportsMade: true,
              userReportsReceived: true,
            },
          },
        },
      }),
    ]);

    return sendSuccess(res, { users, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    next(err);
  }
}

export async function updateAdminUserVerification(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.params.userId;
    const { verified } = req.body as { verified?: boolean };

    if (typeof verified !== 'boolean') {
      throw new ApiError(400, 'INVALID_VERIFICATION_STATUS', 'Verification status must be true or false.');
    }

    const target = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });
    if (!target) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found.');

    if ((target.role === 'admin' || target.role === 'superadmin') && req.user!.role !== 'superadmin') {
      throw new ApiError(403, 'ADMIN_TARGET_REQUIRED', 'Only a superadmin can change another admin account.');
    }

    const now = new Date();
    const user = await prisma.$transaction(async (tx) => {
      const updatedUser = await tx.user.update({
        where: { id: userId },
        data: {
          isVerified: verified,
          verifiedAt: verified ? now : null,
          verifiedBy: verified ? req.user!.id : null,
        },
        select: {
          id: true,
          username: true,
          displayName: true,
          isVerified: true,
          verifiedAt: true,
          verifiedBy: true,
        },
      });

      if (verified) {
        await tx.verificationRequest.updateMany({
          where: { userId, status: VerificationRequestStatus.pending },
          data: {
            status: VerificationRequestStatus.approved,
            adminNote: 'Approved directly by admin.',
            reviewedBy: req.user!.id,
            reviewedAt: now,
          },
        });
      }

      return updatedUser;
    });

    if (verified) {
      createNotification({ userId: user.id, type: 'verification_approved' })
        .catch((err) => console.error('[verification notification] failed', err));
    }

    return sendSuccess(res, { user });
  } catch (err) {
    next(err);
  }
}

export async function updateAdminUserStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.params.userId;
    const { status } = req.body as { status?: string };
    const nextStatus = normalizeStatus(status);

    if (!nextStatus) {
      throw new ApiError(400, 'INVALID_ACCOUNT_STATUS', 'Invalid account status.');
    }

    if (userId === req.user!.id && nextStatus !== 'active') {
      throw new ApiError(400, 'CANNOT_RESTRICT_SELF', 'You cannot restrict your own admin account.');
    }

    const target = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true } });
    if (!target) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found.');

    if ((target.role === 'admin' || target.role === 'superadmin') && req.user!.role !== 'superadmin') {
      throw new ApiError(403, 'ADMIN_TARGET_REQUIRED', 'Only a superadmin can change another admin account.');
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data: { accountStatus: nextStatus },
      select: {
        id: true,
        username: true,
        displayName: true,
        email: true,
        role: true,
        accountStatus: true,
      },
    });

    return sendSuccess(res, { user });
  } catch (err) {
    next(err);
  }
}

export async function listAdminPosts(req: Request, res: Response, next: NextFunction) {
  try {
    const page = pageValue(req.query.page);
    const limit = limitValue(req.query.limit);
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';

    const where = search
      ? {
          OR: [
            { content: { contains: search } },
            { user: { username: { contains: search } } },
            { user: { displayName: { contains: search } } },
          ],
        }
      : {};

    const [total, posts] = await Promise.all([
      prisma.post.count({ where }),
      prisma.post.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: skipFor(page, limit),
        take: limit,
        select: {
          id: true,
          content: true,
          imageUrl: true,
          visibility: true,
          createdAt: true,
          user: { select: { id: true, username: true, displayName: true, profilePictureUrl: true } },
          _count: { select: { likes: true, comments: true, reports: true, reposts: true } },
        },
      }),
    ]);

    return sendSuccess(res, { posts, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    next(err);
  }
}

export async function deleteAdminPost(req: Request, res: Response, next: NextFunction) {
  try {
    const post = await prisma.post.findUnique({ where: { id: req.params.postId }, select: { id: true } });
    if (!post) throw new ApiError(404, 'POST_NOT_FOUND', 'Post not found.');

    await prisma.post.delete({ where: { id: post.id } });
    return sendSuccess(res, { deleted: true, postId: post.id });
  } catch (err) {
    next(err);
  }
}

export async function listAdminReports(req: Request, res: Response, next: NextFunction) {
  try {
    const page = pageValue(req.query.page);
    const limit = limitValue(req.query.limit);

    const [postReports, userReports, commentReports, reelCommentReports] = await Promise.all([
      prisma.report.findMany({
        orderBy: { createdAt: 'desc' },
        skip: skipFor(page, limit),
        take: limit,
        select: {
          id: true,
          reason: true,
          details: true,
          createdAt: true,
          post: { select: { id: true, content: true, user: { select: { id: true, username: true, displayName: true } } } },
          reporter: { select: { id: true, username: true, displayName: true } },
        },
      }),
      prisma.userReport.findMany({
        orderBy: { createdAt: 'desc' },
        skip: skipFor(page, limit),
        take: limit,
        select: {
          id: true,
          reason: true,
          details: true,
          createdAt: true,
          reported: { select: { id: true, username: true, displayName: true, accountStatus: true } },
          reporter: { select: { id: true, username: true, displayName: true } },
        },
      }),
      prisma.commentReport.findMany({
        orderBy: { createdAt: 'desc' },
        skip: skipFor(page, limit),
        take: limit,
        select: {
          id: true,
          reason: true,
          details: true,
          createdAt: true,
          comment: { select: { id: true, content: true, postId: true, user: { select: { id: true, username: true, displayName: true } }, post: { select: { id: true, content: true } } } },
          reporter: { select: { id: true, username: true, displayName: true } },
        },
      }),
      prisma.reelCommentReport.findMany({
        orderBy: { createdAt: 'desc' },
        skip: skipFor(page, limit),
        take: limit,
        select: {
          id: true,
          reason: true,
          details: true,
          createdAt: true,
          comment: { select: { id: true, content: true, reelId: true, user: { select: { id: true, username: true, displayName: true } }, reel: { select: { id: true } } } },
          reporter: { select: { id: true, username: true, displayName: true } },
        },
      }),
    ]);

    return sendSuccess(res, {
      postReports,
      userReports,
      commentReports,
      reelCommentReports,
    });
  } catch (err) {
    next(err);
  }
}

export async function deleteAdminReport(req: Request, res: Response, next: NextFunction) {
  try {
    const type = req.params.type;
    const reportId = req.params.reportId;
    if (type === 'post') {
      await prisma.report.delete({ where: { id: reportId } });
    } else if (type === 'user') {
      await prisma.userReport.delete({ where: { id: reportId } });
    } else if (type === 'comment') {
      await prisma.commentReport.delete({ where: { id: reportId } });
    } else if (type === 'reel-comment') {
      await prisma.reelCommentReport.delete({ where: { id: reportId } });
    } else {
      throw new ApiError(400, 'INVALID_REPORT_TYPE', 'Invalid report type.');
    }
    return sendSuccess(res, { deleted: true, reportType: type, reportId });
  } catch (err) {
    next(err);
  }
}

export async function listAdminComments(req: Request, res: Response, next: NextFunction) {
  try {
    const page = pageValue(req.query.page);
    const limit = limitValue(req.query.limit);
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';

    const where = search
      ? {
          OR: [
            { content: { contains: search } },
            { user: { username: { contains: search } } },
            { user: { displayName: { contains: search } } },
            { post: { content: { contains: search } } },
          ],
        }
      : {};

    const [total, comments] = await Promise.all([
      prisma.comment.count({ where }),
      prisma.comment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: skipFor(page, limit),
        take: limit,
        select: {
          id: true,
          content: true,
          createdAt: true,
          parentCommentId: true,
          user: { select: { id: true, username: true, displayName: true, profilePictureUrl: true } },
          post: { select: { id: true, content: true } },
          _count: { select: { replies: true, reactions: true, reports: true } },
        },
      }),
    ]);

    return sendSuccess(res, {
      comments,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
}

export async function deleteAdminComment(req: Request, res: Response, next: NextFunction) {
  try {
    const comment = await prisma.comment.findUnique({ where: { id: req.params.commentId }, select: { id: true } });
    if (!comment) throw new ApiError(404, 'COMMENT_NOT_FOUND', 'Comment not found.');

    await prisma.comment.delete({ where: { id: comment.id } });
    return sendSuccess(res, { deleted: true, commentId: comment.id });
  } catch (err) {
    next(err);
  }
}

export async function deleteAdminReel(req: Request, res: Response, next: NextFunction) {
  try {
    const reel = await prisma.reel.findUnique({ where: { id: req.params.reelId }, select: { id: true } });
    if (!reel) throw new ApiError(404, 'REEL_NOT_FOUND', 'Reel not found.');

    await prisma.reel.delete({ where: { id: reel.id } });
    return sendSuccess(res, { deleted: true, reelId: reel.id });
  } catch (err) {
    next(err);
  }
}

export async function listAdminAuthFailures(req: Request, res: Response, next: NextFunction) {
  try {
    const page = pageValue(req.query.page);
    const limit = limitValue(req.query.limit);
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const where = search
      ? { OR: [{ email: { contains: search } }, { code: { contains: search } }, { message: { contains: search } }, { stage: { contains: search } }] }
      : {};

    const [total, logs] = await Promise.all([
      prisma.authFailureLog.count({ where }),
      prisma.authFailureLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: skipFor(page, limit),
        take: limit,
      }),
    ]);

    return sendSuccess(res, { logs, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    next(err);
  }
}


async function getVerificationEligibilityForUsers(userIds: string[]) {
  if (!userIds.length) return new Map<string, any>();

  const [users, postCounts, reelCounts, commentCounts, sharedPostCounts] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, createdAt: true, isVerified: true } }),
    prisma.post.groupBy({ by: ['userId'], where: { userId: { in: userIds }, originalPostId: null }, _count: { _all: true } }),
    prisma.reel.groupBy({ by: ['userId'], where: { userId: { in: userIds } }, _count: { _all: true } }),
    prisma.comment.groupBy({ by: ['userId'], where: { userId: { in: userIds } }, _count: { _all: true } }),
    prisma.post.groupBy({ by: ['userId'], where: { userId: { in: userIds }, originalPostId: { not: null } }, _count: { _all: true } }),
  ]);

  const map = new Map<string, any>();
  for (const user of users) {
    const age = Math.floor((Date.now() - user.createdAt.getTime()) / (1000 * 60 * 60 * 24));
    const posts = postCounts.find((x) => x.userId === user.id)?._count._all ?? 0;
    const reels = reelCounts.find((x) => x.userId === user.id)?._count._all ?? 0;
    const comments = commentCounts.find((x) => x.userId === user.id)?._count._all ?? 0;
    const sharedPosts = sharedPostCounts.find((x) => x.userId === user.id)?._count._all ?? 0;
    const requirements = {
      accountAge: { current: age, required: 30, met: age >= 30 },
      posts: { current: posts, required: 10, met: posts >= 10 },
      reels: { current: reels, required: 2, met: reels >= 2 },
      comments: { current: comments, required: 10, met: comments >= 10 },
      sharedPosts: { current: sharedPosts, required: 3, met: sharedPosts >= 3 },
    };
    map.set(user.id, { eligible: Object.values(requirements).every((r) => r.met), requirements, isVerified: user.isVerified });
  }
  return map;
}

export async function listAdminVerificationRequests(req: Request, res: Response, next: NextFunction) {
  try {
    const page = pageValue(req.query.page);
    const limit = limitValue(req.query.limit);
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const rawStatus = typeof req.query.status === 'string' ? req.query.status : '';
    const status = rawStatus === 'pending' || rawStatus === 'approved' || rawStatus === 'rejected'
      ? rawStatus as VerificationRequestStatus
      : undefined;

    const where = {
      ...(status ? { status } : {}),
      ...(search
        ? {
            OR: [
              { reason: { contains: search } },
              { user: { username: { contains: search } } },
              { user: { displayName: { contains: search } } },
              { user: { email: { contains: search } } },
            ],
          }
        : {}),
    };

    const [total, requests] = await Promise.all([
      prisma.verificationRequest.count({ where }),
      prisma.verificationRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: skipFor(page, limit),
        take: limit,
        select: {
          id: true,
          reason: true,
          status: true,
          adminNote: true,
          reviewedBy: true,
          reviewedAt: true,
          createdAt: true,
          user: {
            select: {
              id: true,
              username: true,
              displayName: true,
              email: true,
              profilePictureUrl: true,
              isVerified: true,
            },
          },
        },
      }),
    ]);

    const eligibilityMap = await getVerificationEligibilityForUsers(requests.map((request) => request.user.id));
    const enrichedRequests = requests.map((request) => ({
      ...request,
      eligibility: eligibilityMap.get(request.user.id) ?? null,
    }));

    return sendSuccess(res, { requests: enrichedRequests, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    next(err);
  }
}

export async function reviewAdminVerificationRequest(req: Request, res: Response, next: NextFunction) {
  try {
    const requestId = req.params.requestId;
    const action = req.body?.action;
    const adminNote = typeof req.body?.adminNote === 'string' ? req.body.adminNote.trim() : '';

    if (action !== 'approve' && action !== 'reject') {
      throw new ApiError(400, 'INVALID_VERIFICATION_ACTION', 'Action must be approve or reject.');
    }
    if (adminNote.length > 1000) {
      throw new ApiError(400, 'VERIFICATION_NOTE_TOO_LONG', 'Admin note must be 1000 characters or fewer.');
    }

    const request = await prisma.verificationRequest.findUnique({
      where: { id: requestId },
      select: { id: true, userId: true, status: true },
    });
    if (!request) throw new ApiError(404, 'VERIFICATION_REQUEST_NOT_FOUND', 'Verification request not found.');
    if (request.status !== 'pending') {
      throw new ApiError(409, 'VERIFICATION_REQUEST_ALREADY_REVIEWED', 'This verification request has already been reviewed.');
    }

    if (action === 'approve') {
      const eligibility = (await getVerificationEligibilityForUsers([request.userId])).get(request.userId);
      if (!eligibility?.eligible) {
        throw new ApiError(403, 'VERIFICATION_REQUIREMENTS_NOT_MET', 'This user no longer meets all verification requirements.');
      }
    }

    const now = new Date();
    const nextStatus: VerificationRequestStatus = action === 'approve'
      ? VerificationRequestStatus.approved
      : VerificationRequestStatus.rejected;

    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.verificationRequest.updateMany({
        where: { id: request.id, status: VerificationRequestStatus.pending },
        data: {
          status: nextStatus,
          adminNote: adminNote || null,
          reviewedBy: req.user!.id,
          reviewedAt: now,
        },
      });

      if (updated.count !== 1) {
        throw new ApiError(409, 'VERIFICATION_REQUEST_ALREADY_REVIEWED', 'This verification request has already been reviewed.');
      }

      const user = await tx.user.update({
        where: { id: request.userId },
        data: action === 'approve'
          ? { isVerified: true, verifiedAt: now, verifiedBy: req.user!.id }
          : {},
        select: { id: true, username: true, displayName: true, isVerified: true, verifiedAt: true, verifiedBy: true },
      });

      return user;
    });

    await createNotification({
      userId: request.userId,
      type: action === 'approve' ? 'verification_approved' : 'verification_rejected',
    });

    return sendSuccess(res, { user: result, action });
  } catch (err) {
    next(err);
  }
}


export async function clearAllAdminMessages(_req: Request, res: Response, next: NextFunction) {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const hiddenMessages = await tx.hiddenMessage.deleteMany({});
      const messageReactions = await tx.messageReaction.deleteMany({});
      const messages = await tx.message.deleteMany({});
      const conversationParticipants = await tx.conversationParticipant.deleteMany({});
      const conversations = await tx.conversation.deleteMany({});

      return {
        hiddenMessages: hiddenMessages.count,
        messageReactions: messageReactions.count,
        messages: messages.count,
        conversationParticipants: conversationParticipants.count,
        conversations: conversations.count,
      };
    });

    return sendSuccess(res, { cleared: true, counts: result });
  } catch (err) {
    next(err);
  }
}
