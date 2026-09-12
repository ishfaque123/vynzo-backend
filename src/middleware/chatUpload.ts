import multer from 'multer';

const storage = multer.memoryStorage();

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
