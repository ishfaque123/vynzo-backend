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

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: 'TOO_MANY_REQUESTS', message: 'Too many attempts. Try again later.' } },
});
