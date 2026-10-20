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
