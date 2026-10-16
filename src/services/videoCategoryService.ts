// AI video category detection — watches video frames and picks a category.
// User-ordered 2026-10-16: remove manual category picker, AI auto-detects.

const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const CF_AI_TOKEN = process.env.CLOUDFLARE_AI_TOKEN ?? '';
// Llama 3.2 vision model for image understanding
const VISION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';

export const REEL_CATEGORIES = [
  'comedy', 'music', 'dance', 'sports', 'food', 'travel',
  'fashion', 'tech', 'education', 'gaming', 'pets', 'art',
] as const;

export type ReelCategory = (typeof REEL_CATEGORIES)[number];

/**
 * Classify video frames into one of the reel categories.
 * @param frames base64-encoded JPEG data URLs (or raw base64), up to 3
 * @param caption optional caption text as extra hint
 * @returns detected category, defaults to '' if detection fails
 */
export async function detectVideoCategory(
  frames: string[],
  caption?: string
): Promise<string> {
  if (!CF_ACCOUNT_ID || !CF_AI_TOKEN || frames.length === 0) return '';

  // Use the first frame for classification (most representative)
  const frame = frames[0];
  const imageData = frame.startsWith('data:') ? frame : `data:image/jpeg;base64,${frame}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);

  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/run/${VISION_MODEL}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${CF_AI_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image_url',
                  image_url: { url: imageData },
                },
                {
                  type: 'text',
                  text: `Look at this video frame${caption ? ` (caption: "${caption.slice(0, 200)}")` : ''}. What is this video about? Reply with ONLY ONE word from this list: ${REEL_CATEGORIES.join(', ')}. Just the word, nothing else.`,
                },
              ],
            },
          ],
          max_tokens: 20,
        }),
        signal: controller.signal,
      }
    );

    if (!res.ok) {
      console.log('[videoCategory] Cloudflare vision failed:', res.status);
      return '';
    }
    const data = await res.json();
    const raw = (data?.result?.response ?? '').toLowerCase().trim();
    // Extract the category word from the response
    const found = REEL_CATEGORIES.find((c) => raw.includes(c));
    return found ?? '';
  } catch (e) {
    console.log('[videoCategory] detection error:', (e as Error).message);
    return '';
  } finally {
    clearTimeout(timer);
  }
}
