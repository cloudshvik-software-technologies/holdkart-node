import { Router } from 'express';
import * as c from '../controllers/profileController.js';
import { authenticate } from '../middleware/auth.js';
import { uploadProfileImg } from '../middleware/upload.js';

const r = Router();

/* ── Debug route (no auth) — REMOVE after issue is resolved ───────────────── */
r.get('/debug', c.debugProfile);

r.use(authenticate);
r.get('/get',           c.getProfile);
r.put('/update',        c.updateProfile);
r.post('/upload-image', uploadProfileImg, c.uploadProfileImage);

export default r;