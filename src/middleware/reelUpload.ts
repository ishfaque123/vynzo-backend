import multer from 'multer';

const storage = multer.memoryStorage();

export const reelUpload = multer({
  storage,
  limits: { fileSize: 80 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('video/')) {
      return cb(new Error('Only video files are allowed for reels.'));
    }
    cb(null, true);
  },
});
