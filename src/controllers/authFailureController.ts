import { Request, Response, NextFunction } from 'express';
import { sendSuccess } from '../utils/ApiResponse';
import { logAuthFailure } from '../services/authFailureLogService';

export async function reportAuthFailure(req: Request, res: Response, next: NextFunction) {
  try {
    const body = req.body as {
      platform?: string;
      stage?: string;
      code?: string;
      message?: string;
      email?: string;
      appVersion?: string;
    };

    if (!body.message || typeof body.message !== 'string') {
      return res.status(400).json({ success: false, error: { code: 'AUTH_ERROR_MESSAGE_REQUIRED', message: 'Authentication error message is required.' } });
    }

    await logAuthFailure({
      platform: body.platform,
      stage: body.stage,
      code: body.code,
      message: body.message,
      email: body.email,
      appVersion: body.appVersion,
      userAgent: req.get('user-agent'),
      ipAddress: req.ip,
    });

    return sendSuccess(res, { recorded: true });
  } catch (err) {
    next(err);
  }
}
