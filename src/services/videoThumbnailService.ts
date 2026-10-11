import { createReadStream } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { execFile } from 'child_process';
import { uploadStreamToR2 } from '../config/r2';

const execFileAsync = promisify(execFile);

/**
 * Returns the duration of a local video file in seconds via ffprobe.
 * Returns null when the duration cannot be determined.
 */
export async function getVideoDurationSec(videoPath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      ['-hide_banner', '-loglevel', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', videoPath],
      { maxBuffer: 1024 * 1024 }
    );
    const sec = parseFloat(String(stdout).trim());
    return Number.isFinite(sec) ? sec : null;
  } catch {
    return null;
  }
}

/**
 * Extracts a single JPEG frame from a local video file and uploads it to R2.
 * Used to auto-generate thumbnails for videos (stories, reels) so clients
 * never render a bare <video> element without a poster — the Instagram/FB pattern.
 *
 * @param videoPath local path to the video file
 * @param atSec timestamp in seconds to capture (e.g. 0.5)
 * @param r2Folder R2 folder prefix, e.g. 'status-thumbnails'
 * @returns public R2 URL of the uploaded thumbnail
 */
export async function extractVideoFrameToR2(videoPath: string, atSec: number, r2Folder: string): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'frianzo-thumb-'));
  const outPath = path.join(tempDir, 'thumb.jpg');
  try {
    await execFileAsync(
      'ffmpeg',
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-ss', String(Math.max(0, atSec)),
        '-i', videoPath,
        '-vframes', '1',
        '-vf', 'scale=540:-1',
        '-q:v', '4',
        outPath,
      ],
      { maxBuffer: 8 * 1024 * 1024 }
    );
    return await uploadStreamToR2(createReadStream(outPath), 'image/jpeg', r2Folder, 'jpg');
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
