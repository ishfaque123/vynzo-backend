import multer from 'multer';
import { mkdirSync } from 'fs';
import { randomUUID } from 'crypto';
import path from 'path';

// Disk storage (same pattern as reelUpload): status media can be up to
// 50 MB — holding the whole file in RAM (memoryStorage) doubled up with
// the controller's own temp-file copy and spiked memory on every upload.
const uploadDir = '/tmp/frianzo-status';
mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${randomUUID()}${ext}`);
  },
});

export const statusUpload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/') && !file.mimetype.startsWith('video/')) {
      return cb(new Error('Only images or videos are allowed.'));
    }
    cb(null, true);
  },
});
