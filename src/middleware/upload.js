import multer from 'multer';
import path from 'path';
import fs from 'fs';

// ── Profile image upload ────────────────────────────────────────────────────
const profileStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = 'uploads/profiles/';
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, `customer_${Date.now()}${path.extname(file.originalname)}`);
  },
});

export const uploadProfileImg = multer({
  storage: profileStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/image/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files allowed'));
  },
}).single('profileImage');

// ── Review images upload (up to 5 images, 5 MB each) ───────────────────────
const reviewStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = 'uploads/reviews/';
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, `review_${Date.now()}_${Math.random().toString(36).slice(2)}${path.extname(file.originalname)}`);
  },
});

export const uploadReviewImages = multer({
  storage: reviewStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/image/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files allowed'));
  },
}).array('reviewImages', 5);