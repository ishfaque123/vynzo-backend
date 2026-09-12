import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';
import { ApiError } from './errorHandler';

const allowedOrigin = new URL(env.frontendUrl).origin;
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// CSRF defense: frontend and backend live on different subdomains
// (frianzo.online / api.frianzo.online), which forces our auth cookies to
// use SameSite=None — so SameSite alone can't block cross-site requests.
// Every real request from our own frontend is a CORS request and browsers
// always attach an Origin header to those, so we require it to be present
// and match our frontend's origin for any state-changing method. This runs
// globally, before routes see the request, so no individual controller can
// accidentally ship a mutating endpoint without this check.
export function verifyOrigin(req: Request, _res: Response, next: NextFunction) {
  if (!MUTATING_METHODS.has(req.method)) return next();

  const origin = req.headers.origin;
  if (!origin) {
    return next(new ApiError(403, 'MISSING_ORIGIN', 'Request origin could not be verified.'));
  }

  let originHost: string;
  try {
    originHost = new URL(origin).origin;
  } catch {
    return next(new ApiError(403, 'INVALID_ORIGIN', 'Request origin could not be verified.'));
  }

  if (originHost !== allowedOrigin) {
    return next(new ApiError(403, 'INVALID_ORIGIN', 'Cross-site request blocked.'));
  }

  next();
}
