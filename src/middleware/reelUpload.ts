import multer from 'multer';
import { mkdirSync } from 'fs';
import { randomUUID } from 'crypto';
import path from 'path';

const uploadDir = '/tmp/frianzo-reels';
mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${randomUUID()}${ext}`);
  },
});

export const reelUpload = multer({
  storage,
  limits: { fileSize: 300 * 1024 * 1024 }, // room for a 3-minute video at normal phone-camera bitrate
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('video/')) {
      return cb(new Error('Only video files are allowed for reels.'));
    }
    cb(null, true);
  },
});
