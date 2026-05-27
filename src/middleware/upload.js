import multer from 'multer';
  import path from 'path';
  import fs from 'fs';

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
  