import rateLimit from 'express-rate-limit';

export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  // 1000 per 15 min per IP: mobile carriers share public IPs (CGNAT), so a
  // low per-IP cap blocks innocent users. Brute-force protection stays on
  // the dedicated authLimiter for sensitive endpoints.
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
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
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Too many attempts. Try again later.' } },
});
