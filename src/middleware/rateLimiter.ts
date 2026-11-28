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

// Public top-reels list (sitemap + crawlers): cheap read-only GET, but
// unauthenticated, so it gets its own tighter per-IP cap on top of the
// global limiter. Keyed by IP only — no user is ever attached on this
// route. 300 requests per 15 minutes per IP is far above what a sitemap
// fetch needs (the frontend sitemap calls it a few times a day) while
// still capping abusive paging.
export const publicReelsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => req.ip ?? 'unknown',
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Too many requests. Please try again later.' } },
});
