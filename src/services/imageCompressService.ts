import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const execFileAsync = promisify(execFile);

const COMPRESSIBLE = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);

/**
 * Compress an uploaded image (user-ordered 2026-10-20: photos as light as
 * possible without ruining quality). Phone photos arrived at 3-6MB and were
 * stored untouched, so every viewer downloaded the full file. Now the longest
 * side is capped at 1600px (WhatsApp-style) and the image is re-encoded as
 * JPEG q6 — measured: 1.4MB screenshot -> 124KB, camera photos land ~300-600KB.
 *
 * Fail-safe by design: non-photo types pass through untouched, any ffmpeg
 * error returns the original buffer, and if the re-encode is not SMALLER the
 * original is kept — an upload can never break or get heavier because of
 * this step.
 */
export async function compressImageBuffer(
  buffer: Buffer,
  mimeType: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  if (!COMPRESSIBLE.has(mimeType)) return { buffer, mimeType };
  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fri-img-'));
    const inPath = join(dir, 'in');
    const outPath = join(dir, 'out.jpg');
    await writeFile(inPath, buffer);
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-i', inPath,
        '-vf', "scale='min(1600,iw)':'min(1600,ih)':force_original_aspect_ratio=decrease",
        '-q:v', '6',
        outPath,
      ],
      { timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
    );
    const out = await readFile(outPath);
    if (out.length > 0 && out.length < buffer.length) {
      return { buffer: out, mimeType: 'image/jpeg' };
    }
    return { buffer, mimeType };
  } catch (err) {
    console.error('[image] compression failed, using original', err);
    return { buffer, mimeType };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Avatar thumbnail (2026-11-02): a ~96px JPEG for the 24-40px avatar
 * circles in feed/comments/reels. The full 1600px avatar (~300-600KB) is
 * far too large for a 40px circle; a 96px JPEG is typically ~3-8KB.
 *
 * Best-effort by design: returns null on any failure (non-photo input,
 * ffmpeg error, empty output) and the caller must keep the full avatar
 * working without a thumbnail — an upload can never break because of it.
 * The thumbnail is stored under the full avatar's R2 key with "-thumb"
 * inserted before the extension, so no DB column is needed to find it:
 *   avatars/<uuid>.jpg  ->  avatars/<uuid>-thumb.jpg
 */
export async function compressThumbnailBuffer(
  buffer: Buffer,
  mimeType: string,
): Promise<Buffer | null> {
  if (!COMPRESSIBLE.has(mimeType)) return null;
  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fri-thumb-'));
    const inPath = join(dir, 'in');
    const outPath = join(dir, 'thumb.jpg');
    await writeFile(inPath, buffer);
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-i', inPath,
        '-vf', "scale='min(96,iw)':'min(96,ih)':force_original_aspect_ratio=decrease",
        '-q:v', '7',
        outPath,
      ],
      { timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
    );
    const out = await readFile(outPath);
    if (out.length > 0) return out;
    return null;
  } catch (err) {
    console.error('[image] thumbnail failed, keeping full avatar only', err);
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Derive the thumbnail R2 key from a full R2 image URL, or null if it is
 * not one of our R2 URLs. The thumbnail lives under the full image's key
 * with "-thumb" inserted before the extension:
 *   posts/<uuid>.jpg  ->  posts/<uuid>-thumb.jpg
 *   avatars/<uuid>.jpg -> avatars/<uuid>-thumb.jpg
 * No DB column is needed to find a thumb. */
export function thumbKeyForUrl(fullUrl: string, r2PublicUrl: string): string | null {
  const prefix = `${r2PublicUrl}/`;
  if (!fullUrl.startsWith(prefix)) return null;
  const key = fullUrl.slice(prefix.length);
  const dot = key.lastIndexOf('.');
  if (dot <= 0) return null;
  return `${key.slice(0, dot)}-thumb${key.slice(dot)}`;
}

/** Derive the thumbnail's full public URL from a full R2 image URL, or null
 * when the URL is missing or is not one of our R2 URLs. Pure string math —
 * it does NOT check whether the thumb object actually exists, so callers
 * must tolerate a 404 (old uploads predate thumbs). */
export function thumbUrlForUrl(fullUrl: string | null | undefined, r2PublicUrl: string): string | null {
  if (!fullUrl) return null;
  const key = thumbKeyForUrl(fullUrl, r2PublicUrl);
  return key ? `${r2PublicUrl}/${key}` : null;
}

/** Derive the thumbnail R2 key from a full avatar URL, or null if it is not one of our R2 avatar URLs. */
export function avatarThumbKeyForUrl(fullUrl: string, r2PublicUrl: string): string | null {
  return thumbKeyForUrl(fullUrl, r2PublicUrl);
}

/**
 * Post-photo thumbnail (2026-11-11): a ~320px JPEG for blur-up loading
 * (FB/Instagram style — the tiny blurred photo shows instantly, then the
 * full photo sharpens in). The full post photo is up to 1600px (~300-600KB);
 * a 320px JPEG is typically ~10-25KB, so it arrives near-instantly even on
 * slow mobile data.
 *
 * Best-effort by design, mirroring compressThumbnailBuffer: returns null
 * on any failure and the caller must keep the full photo working without
 * a thumbnail — an upload can never break because of it.
 */
export async function compressPostThumbBuffer(
  buffer: Buffer,
  mimeType: string,
): Promise<Buffer | null> {
  if (!COMPRESSIBLE.has(mimeType)) return null;
  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fri-post-thumb-'));
    const inPath = join(dir, 'in');
    const outPath = join(dir, 'thumb.jpg');
    await writeFile(inPath, buffer);
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-i', inPath,
        '-vf', "scale='min(320,iw)':'min(320,ih)':force_original_aspect_ratio=decrease",
        '-q:v', '7',
        outPath,
      ],
      { timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
    );
    const out = await readFile(outPath);
    if (out.length > 0) return out;
    return null;
  } catch (err) {
    console.error('[image] post thumbnail failed, keeping full photo only', err);
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
