import { z } from 'zod';

export const googleLoginSchema = z.object({
  idToken: z.string().min(10),
});

export const switchAccountSchema = z.object({
  accountId: z.string().uuid(),
});
