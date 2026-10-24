import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
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
 * File-based twin of compressImageBuffer for uploads that already live on
 * disk (multer diskStorage): same ffmpeg settings, same fail-safe rules,
 * but the image bytes never pass through RAM as a Buffer. The caller gets
 * the path to use (the original file, or a compressed temp file) and MUST
 * call cleanup() once it has finished streaming/reading that path —
 * cleanup only ever removes the temp dir this function created, never the
 * original upload.
 */
export async function compressImageFile(
  filePath: string,
  mimeType: string,
): Promise<{ filePath: string; mimeType: string; cleanup: () => Promise<void> }> {
  const original = { filePath, mimeType, cleanup: async () => {} };
  if (!COMPRESSIBLE.has(mimeType)) return original;
  let dir: string | null = null;
  try {
    dir = await mkdtemp(join(tmpdir(), 'fri-img-'));
    const outPath = join(dir, 'out.jpg');
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-i', filePath,
        '-vf', "scale='min(1600,iw)':'min(1600,ih)':force_original_aspect_ratio=decrease",
        '-q:v', '6',
        outPath,
      ],
      { timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
    );
    const [inStat, outStat] = await Promise.all([stat(filePath), stat(outPath)]);
    if (outStat.size > 0 && outStat.size < inStat.size) {
      const tempDir = dir;
      return {
        filePath: outPath,
        mimeType: 'image/jpeg',
        cleanup: async () => { await rm(tempDir, { recursive: true, force: true }).catch(() => {}); },
      };
    }
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    return original;
  } catch (err) {
    console.error('[image] compression failed, using original', err);
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    return original;
  }
}
