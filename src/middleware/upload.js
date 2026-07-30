// src/middleware/upload.js
//
// MIGRATED TO S3: files are now parsed into memory (multer.memoryStorage())
// instead of being written to local disk. Controllers take req.file.buffer /
// req.files[].buffer and upload it to S3 via src/config/s3.js — nothing
// downstream (services, DB columns) changes, since they only ever dealt
// with an image URL string.
import multer from 'multer';

const memoryStorage = multer.memoryStorage();

const imageFileFilter = (req, file, cb) => {
  if (/image/.test(file.mimetype)) cb(null, true);
  else cb(new Error('Only image files allowed'));
};

// ── Profile image upload ────────────────────────────────────────────────────
export const uploadProfileImg = multer({
  storage: memoryStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: imageFileFilter,
}).single('profileImage');

// ── Review images upload (up to 5 images, 5 MB each) ───────────────────────
export const uploadReviewImages = multer({
  storage: memoryStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: imageFileFilter,
}).array('reviewImages', 5);

// Part 2 — return-request evidence (up to 5 images, 5 MB each). Required
// only for seller-fault return reasons (defective/damaged/wrong item etc.),
// compared against the seller's Part 1 pre-pickup photo to help judge
// seller-fault vs transit damage.
// Widened for Part 3 — video is required above a configurable order value.
const evidenceFileFilter = (req, file, cb) => {
  if (/^(image|video)\//.test(file.mimetype)) cb(null, true);
  else cb(new Error('Only image or video files are allowed'));
};

export const uploadReturnEvidence = multer({
  storage: memoryStorage,
  limits: { fileSize: 50 * 1024 * 1024 }, // videos are larger than photos
  fileFilter: evidenceFileFilter,
}).array('evidencePhotos', 5);

export const withMulterErrors = (multerMiddleware) => (req, res, next) => {
  multerMiddleware(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      const messages = {
        LIMIT_FILE_SIZE:  'Each image must be 5MB or smaller',
        LIMIT_FILE_COUNT: 'Too many files — maximum 5 images',
        LIMIT_UNEXPECTED_FILE: 'Unexpected file field',
      };
      return res.status(400).json({ message: messages[err.code] || err.message });
    }
    return res.status(400).json({ message: err.message || 'Upload failed' });
  });
};
