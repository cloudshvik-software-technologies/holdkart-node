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
