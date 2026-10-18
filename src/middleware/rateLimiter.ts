import rateLimit from 'express-rate-limit';

export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  // BEST: Key by user ID for logged-in users, IP for guests.
  // Mobile carriers share public IPs (CGNAT) - per-IP limits block innocent users.
  // User-ID keying means each person gets their own limit, no matter the network.
  max: 5000,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => req.user?.id ?? req.ip ?? 'unknown',
});

export const postCreateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  // Key by user ID (not IP): auth runs before this limiter, and mobile
  // carriers share IPs (CGNAT) so per-IP caps would block innocent users.
  keyGenerator: (req: any) => req.user?.id ?? req.ip ?? 'unknown',
  message: { success: false, error: { code: 'TOO_MANY_POSTS', message: 'You are posting too fast. Please try again later.' } },
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Too many attempts. Please wait a minute and try again.' } },
});
