import { z } from 'zod';

const USERNAME_REGEX = /^[a-zA-Z0-9_.]{3,30}$/;

export const profileSetupSchema = z.object({
  username: z.string().regex(USERNAME_REGEX, 'Username must be 3-30 characters: letters, numbers, underscore, or period.'),
  displayName: z.string().min(1).max(50),
  dateOfBirth: z.string().refine((val) => {
    const date = new Date(val);
    if (isNaN(date.getTime())) return false;
    const now = new Date();
    const age = (now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
    return date < now && age >= 13 && age < 120;
  }, 'Enter a valid date of birth (must be at least 13 years old).'),
  bio: z.string().max(300).optional(),
  gender: z.enum(['male', 'female', 'custom']).optional(),
  phone: z.string().max(30).optional(),
  country: z.string().max(60).optional(),
});

export const profileUpdateSchema = z.object({
  username: z.string().regex(USERNAME_REGEX, 'Username must be 3-30 characters: letters, numbers, underscore, or period.').optional(),
  displayName: z.string().min(1).max(50).optional(),
  dateOfBirth: z.string().optional(),
  bio: z.string().max(300).optional(),
  gender: z.enum(['male', 'female', 'custom']).optional(),
  website: z.string().max(200).optional(),
  phone: z.string().max(30).optional(),
  province: z.string().max(50).optional(),
  city: z.string().max(50).optional(),
  country: z.string().max(60).optional(),
  messagePermission: z.enum(['everyone', 'followers', 'none']).optional(),
  tagPermission: z.enum(['everyone', 'followers', 'none']).optional(),
  showOnlineStatus: z.boolean().optional(),
  isPrivate: z.boolean().optional(),
});
