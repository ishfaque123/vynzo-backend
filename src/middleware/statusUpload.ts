import multer from 'multer';

const storage = multer.memoryStorage();

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
