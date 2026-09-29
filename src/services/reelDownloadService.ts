import { createWriteStream } from 'fs';
import { mkdtemp, readFile, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { execFile } from 'child_process';
import { ApiError } from '../middleware/errorHandler';

const execFileAsync = promisify(execFile);

function escapeDrawtext(value: string) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'");
}

async function downloadOriginal(url: string, outputPath: string) {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new ApiError(502, 'REEL_DOWNLOAD_SOURCE_ERROR', 'Unable to fetch the reel video.');
  const file = createWriteStream(outputPath);
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) file.write(Buffer.from(value));
    }
  } finally {
    await new Promise<void>((resolve, reject) => file.end((err: NodeJS.ErrnoException | null) => err ? reject(err) : resolve()));
  }
}

export async function createWatermarkedReelDownload(videoUrl: string, username: string) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'frianzo-reel-'));
  const inputPath = path.join(tempDir, 'input.mp4');
  const outputPath = path.join(tempDir, 'frianzo-watermarked.mp4');

  try {
    await downloadOriginal(videoUrl, inputPath);

    const watermark = escapeDrawtext(`Frianzo  @${username}`);
    const filter = [
      "drawtext=font='Sans':fontcolor=white@0.82:fontsize=h*0.035:box=1:boxcolor=black@0.28:boxborderw=12",
      `text='${watermark}'`,
      "x='if(lt(mod(t\\,16)\\,4),w-tw-28,if(lt(mod(t\\,16)\\,8),28,if(lt(mod(t\\,16)\\,12),w-tw-28,28)))'",
      "y='if(lt(mod(t\\,16)\\,4),28,if(lt(mod(t\\,16)\\,8),h-th-38,if(lt(mod(t\\,16)\\,12),h-th-38,28)))'"
    ].join(':');

    await execFileAsync('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', inputPath,
      '-vf', filter,
      '-map', '0:v:0',
      '-map', '0:a?',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      '-c:a', 'aac',
      '-movflags', '+faststart',
      outputPath,
    ], { maxBuffer: 1024 * 1024 * 8 });

    return await readFile(outputPath);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    console.error('[reel-download] ffmpeg processing failed', err);
    throw new ApiError(500, 'REEL_DOWNLOAD_PROCESSING_FAILED', 'Unable to create the watermarked video.');
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
