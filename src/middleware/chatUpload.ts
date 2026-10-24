import multer from 'multer';
import { mkdirSync } from 'fs';
import { randomUUID } from 'crypto';
import path from 'path';

// Disk storage (same pattern as reelUpload): chat media can be up to
// 15 MB — no need to hold the whole file in RAM (memoryStorage).
const uploadDir = '/tmp/frianzo-chat';
mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${randomUUID()}${ext}`);
  },
});

export const chatUpload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/') && !file.mimetype.startsWith('audio/')) {
      return cb(new Error('Only images or audio files are allowed.'));
    }
    cb(null, true);
  },
});
