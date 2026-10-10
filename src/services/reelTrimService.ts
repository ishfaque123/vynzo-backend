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

const FILTER_FFMPEG: Record<string, string> = {
  warm: 'eq=brightness=0.03:saturation=1.25:contrast=1.05,colorbalance=rs=0.15:gs=0.05:bs=-0.1',
  cool: 'eq=brightness=0.02:saturation=1.15:contrast=1.05,colorbalance=rs=-0.1:gs=0.02:bs=0.12',
  bw: 'hue=s=0,eq=contrast=1.1',
  vintage: 'eq=brightness=0.02:saturation=0.75:contrast=0.95,colorbalance=rs=0.12:gs=0.06:bs=-0.08',
  vivid: 'eq=saturation=1.5:contrast=1.12:brightness=0.01',
};

export async function createTrimmedReel(videoUrl: string, startSec: number, endSec: number, filter?: string) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'frianzo-reel-trim-'));
  const inputPath = path.join(tempDir, 'input.mp4');
  const outputPath = path.join(tempDir, 'trimmed.mp4');
  try {
    await downloadOriginal(videoUrl, inputPath);
    const vf = filter && FILTER_FFMPEG[filter] ? FILTER_FFMPEG[filter] : null;
    const args = ['-hide_banner', '-loglevel', 'error', '-y'];
    if (startSec > 0) args.push('-ss', String(startSec));
    args.push('-i', inputPath);
    if (endSec > startSec) args.push('-t', String(endSec - startSec));
    if (vf) args.push('-vf', vf);
    args.push(
      '-map', '0:v:0',
      '-map', '0:a?',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      '-c:a', 'aac',
      '-movflags', '+faststart',
      outputPath,
    );
    await execFileAsync('ffmpeg', args, { maxBuffer: 8 * 1024 * 1024 });
    return await uploadStreamToR2(createReadStream(outputPath), 'video/mp4', 'reels', 'mp4');
  } catch (err) {
    if (err instanceof ApiError) throw err;
    console.error('[reel-trim] ffmpeg processing failed', err);
    throw new ApiError(500, 'REEL_TRIM_PROCESSING_FAILED', 'Unable to process the video. Please try again.');
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}