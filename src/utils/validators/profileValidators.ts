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
  readReceiptsEnabled: z.boolean().optional(),
  // Account-level default disappearing timer for NEW conversations:
  // null = Off, otherwise one of 24 hours / 7 days / 90 days (seconds).
  defaultDisappearingDuration: z
    .union([z.literal(86400), z.literal(604800), z.literal(7776000)])
    .nullable()
    .optional(),
  // Chat wallpaper: either a preset key from the shared preset list or the
  // URL of an image the user uploaded through the chat media upload path.
  chatWallpaper: z
    .string()
    .max(500)
    .refine(
      (v) =>
        ['default', 'beige', 'green', 'blue', 'pink', 'dark', 'dusk', 'ocean', 'dots'].includes(v) ||
        v.includes('/chat-media/'),
      'Invalid chat wallpaper.'
    )
    .nullable()
    .optional(),
  isPrivate: z.boolean().optional(),
  publicKey: z.string().max(2000).optional(),
  category: z.enum(['Personal', 'Video Creator', 'Business', 'Artist', 'Public Figure', 'Other']).nullable().optional(),
  socialLinks: z.object({
    facebook: z.string().max(200).optional(),
    instagram: z.string().max(200).optional(),
    youtube: z.string().max(200).optional(),
    tiktok: z.string().max(200).optional(),
  }).optional(),
  introPrivacy: z.object({
    category: z.boolean().optional(),
    location: z.boolean().optional(),
    dateOfBirth: z.boolean().optional(),
    gender: z.boolean().optional(),
    website: z.boolean().optional(),
    facebook: z.boolean().optional(),
    instagram: z.boolean().optional(),
    youtube: z.boolean().optional(),
    tiktok: z.boolean().optional(),
    phone: z.boolean().optional(),
    email: z.boolean().optional(),
  }).optional(),
});
