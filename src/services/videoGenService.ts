/**
 * AI Video Generation Service using Google Gemini Veo API
 * Supports text-to-video generation via Veo 3.1
 */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? '';
const VEO_MODEL = 'veo-3.1-fast-generate-preview'; // Cheapest: $0.10/sec

interface VideoGenResult {
  success: boolean;
  videoUrl?: string;
  error?: string;
  operationName?: string;
}

interface VideoGenStatus {
  done: boolean;
  videoUrl?: string;
  error?: string;
}

/**
 * Start video generation (async - returns operation name)
 */
export async function startVideoGeneration(
  prompt: string,
  aspectRatio: '16:9' | '9:16' = '9:16',
  durationSeconds: 4 | 8 = 8
): Promise<VideoGenResult> {
  if (!GEMINI_API_KEY) {
    return { success: false, error: 'Video generation not configured' };
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${VEO_MODEL}:predictLongRunning`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': GEMINI_API_KEY,
        },
        body: JSON.stringify({
          instances: [{ prompt }],
          parameters: {
            aspectRatio,
            durationSeconds,
          },
        }),
      }
    );

    if (!response.ok) {
      const err = await response.text();
      // Quota/billing errors → friendly premium message instead of raw API error
      if (response.status === 429 || /quota|billing|exceeded/i.test(err)) {
        return { success: false, error: 'PREMIUM_REQUIRED' };
      }
      return { success: false, error: `Veo API error: ${err.slice(0, 200)}` };
    }

    const data = await response.json();
    return {
      success: true,
      operationName: data.name,
    };
  } catch (e: any) {
    return { success: false, error: e.message || 'Failed to start video generation' };
  }
}

/**
 * Check video generation status (poll this until done)
 */
export async function checkVideoStatus(operationName: string): Promise<VideoGenStatus> {
  if (!GEMINI_API_KEY) {
    return { done: false, error: 'Video generation not configured' };
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${operationName}`,
      {
        headers: { 'x-goog-api-key': GEMINI_API_KEY },
      }
    );

    if (!response.ok) {
      return { done: false, error: 'Failed to check status' };
    }

    const data = await response.json();

    if (!data.done) {
      return { done: false };
    }

    // Extract video URL from response
    const videoUri = data.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
    if (videoUri) {
      return { done: true, videoUrl: videoUri };
    }

    return { done: true, error: 'No video in response (may be blocked by safety filter)' };
  } catch (e: any) {
    return { done: false, error: e.message };
  }
}

/**
 * Check if video generation is configured
 */
export function isVideoGenEnabled(): boolean {
  return !!GEMINI_API_KEY;
}

export const VIDEO_GEN_REFERRAL_THRESHOLD = 25;

/**
 * Check if a user has unlocked AI video generation, either via referrals
 * or an admin force-grant (videoGenForced).
 * (user-ordered 2026-10-16): 25 completed referrals = free access,
 * instead of a premium paywall.
 */
export async function hasVideoGenAccess(userId: string): Promise<{ hasAccess: boolean; referralCount: number; needed: number }> {
  const { prisma } = await import('../config/prisma');
  let videoGenForced = false;
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { videoGenForced: true },
    });
    videoGenForced = user?.videoGenForced === true;
  } catch {
    // The video_gen_forced column may not exist yet if the startup ensure
    // step has not run; referral-based access must keep working regardless.
    videoGenForced = false;
  }
  const referralCount = await prisma.referral.count({ where: { referrerId: userId } });
  return {
    hasAccess: videoGenForced || referralCount >= VIDEO_GEN_REFERRAL_THRESHOLD,
    referralCount,
    needed: Math.max(0, VIDEO_GEN_REFERRAL_THRESHOLD - referralCount),
  };
}
