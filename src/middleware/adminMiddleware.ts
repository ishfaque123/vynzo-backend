import { Request, Response, NextFunction } from 'express';
import { ApiError } from './errorHandler';

export function adminMiddleware(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) {
    return next(new ApiError(401, 'NOT_AUTHENTICATED', 'Login required.'));
  }

  if (req.user.role !== 'admin' && req.user.role !== 'superadmin') {
    return next(new ApiError(403, 'ADMIN_ACCESS_REQUIRED', 'Admin access required.'));
  }

  return next();
}
