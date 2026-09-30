import { createWriteStream } from 'fs';
import { mkdtemp, readFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { execFile } from 'child_process';
import { createReadStream } from 'fs';
import { ApiError } from '../middleware/errorHandler';
import { uploadStreamToR2 } from '../config/r2';

const execFileAsync = promisify(execFile);

async function downloadOriginal(url: string, outputPath: string) {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new ApiError(502, 'REEL_TRIM_SOURCE_ERROR', 'Unable to fetch the reel video for trimming.');
  const file = createWriteStream(outputPath);
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      file.write(Buffer.from(value));
    }
  } finally {
    await new Promise<void>((resolve, reject) => file.end((err: NodeJS.ErrnoException | null) => err ? reject(err) : resolve()));
  }
}

export async function createTrimmedReel(videoUrl: string, startSec: number, endSec: number) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'frianzo-reel-trim-'));
  const inputPath = path.join(tempDir, 'input.mp4');
  const outputPath = path.join(tempDir, 'trimmed.mp4');
  try {
    await downloadOriginal(videoUrl, inputPath);
    await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', String(startSec),
      '-i', inputPath,
      '-t', String(endSec - startSec),
      '-map', '0:v:0',
      '-map', '0:a?',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      '-c:a', 'aac',
      '-movflags', '+faststart',
      outputPath,
    ], { maxBuffer: 8 * 1024 * 1024 });
    return await uploadStreamToR2(createReadStream(outputPath), 'video/mp4', 'reels', 'mp4');
  } catch (err) {
    if (err instanceof ApiError) throw err;
    console.error('[reel-trim] ffmpeg processing failed', err);
    throw new ApiError(500, 'REEL_TRIM_PROCESSING_FAILED', 'Unable to trim the video. Please try again.');
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}