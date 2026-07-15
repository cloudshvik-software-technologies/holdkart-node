import * as svc from '../services/profileService.js';
import db from '../config/db.js';
import { uploadBufferToS3, buildKey, deleteFromS3 } from '../config/s3.js';
import env from '../config/env.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// S3 is only usable when real credentials + a bucket are configured. Locally
// (no AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / S3_BUCKET_NAME in .env),
// every S3 call fails, so profile photo uploads fall back to writing the
// buffer to the same local /uploads folder app.js already serves statically
// — this only affects this dev fallback path, production S3 behaviour is
// unchanged once real credentials are present.
const s3Configured = Boolean(env.s3.accessKeyId && env.s3.secretAccessKey && env.s3.bucket);

const saveBufferLocally = (buffer, originalname) => {
  const ext = (originalname.match(/\.[a-zA-Z0-9]+$/) || [''])[0].toLowerCase();
  const dir = path.join(__dirname, '..', '..', 'uploads', 'profiles');
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${randomUUID()}${ext}`;
  fs.writeFileSync(path.join(dir, filename), buffer);
  return `/uploads/profiles/${filename}`;
};

const deleteLocalFile = (urlOrKey) => {
  if (!urlOrKey?.startsWith('/uploads/')) return;
  try { fs.unlinkSync(path.join(__dirname, '..', '..', urlOrKey)); } catch { /* already gone */ }
};

export const getProfile = async (req, res) => {
  try {
    const p = await svc.getProfile(req.customer.id);
    if (!p) return res.status(404).json({ message: 'Profile not found' });
    res.json(p);
  } catch (e) {
    console.error('[profileController.getProfile] ERROR:', e.message);
    console.error(e.stack);
    res.status(500).json({
      message: 'Failed to load profile',
      detail:  e.message,
      hint:    'Check your Node terminal for the full error. Most likely cause: schema.sql has not been run yet, or the customer table is missing columns.',
    });
  }
};

export const updateProfile = async (req, res) => {
  try {
    res.json(await svc.updateProfile({ ...req.body, customerId: req.customer.id }));
  } catch (e) {
    console.error('[profileController.updateProfile] ERROR:', e.message);
    res.status(500).json({ message: e.message });
  }
};

export const uploadProfileImage = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file provided' });
    const customerId = req.customer.id;
    let imageUrl;
    if (s3Configured) {
      const key = buildKey('profile-images', customerId, req.file.originalname);
      imageUrl = await uploadBufferToS3({
        buffer:      req.file.buffer,
        key,
        contentType: req.file.mimetype,
      });
    } else {
      imageUrl = saveBufferLocally(req.file.buffer, req.file.originalname);
    }
    res.json(await svc.uploadProfileImage({ customerId, imageUrl }));
  } catch (e) {
    console.error('[profileController.uploadProfileImage] ERROR:', e.message);
    res.status(500).json({ message: e.message });
  }
};

export const deleteProfileImage = async (req, res) => {
  try {
    const customerId = req.customer.id;
    const current = await svc.getProfile(customerId);
    if (current?.profile_image) {
      if (current.profile_image.startsWith('/uploads/')) deleteLocalFile(current.profile_image);
      else await deleteFromS3(current.profile_image);
    }
    res.json(await svc.deleteProfileImage({ customerId }));
  } catch (e) {
    console.error('[profileController.deleteProfileImage] ERROR:', e.message);
    res.status(500).json({ message: e.message });
  }
};
// Returns pending orders, active deals, and account status for the 3-step
// deactivation modal (step 2 — account info review).
export const getDeactivationInfo = async (req, res) => {
  try {
    res.json(await svc.getDeactivationInfo(req.customer.id));
  } catch (e) {
    console.error('[profileController.getDeactivationInfo] ERROR:', e.message);
    res.status(500).json({ message: e.message });
  }
};

// Pending orders / active deals shown to the customer before they confirm deactivation.
export const getDeactivationWarnings = async (req, res) => {
  try {
    res.json(await svc.getDeactivationWarnings(req.customer.id));
  } catch (e) {
    console.error('[profileController.getDeactivationWarnings] ERROR:', e.message);
    res.status(500).json({ message: e.message });
  }
};

// FLIPKART-STYLE DEACTIVATION: customer confirms with password; account is
// soft-deactivated (not deleted). Logging back in shows a locked screen
// with an explicit "Activate" button (see reactivateAccount below).
export const deactivateAccount = async (req, res) => {
  try {
    res.json(await svc.deactivateAccount({
      customerId: req.customer.id,
      password:   req.body.password,
      reason:     req.body.reason || '',
    }));
  } catch (e) {
    console.error('[profileController.deactivateAccount] ERROR:', e.message);
    res.status(e.status || 500).json({ message: e.message });
  }
};

export const reactivateAccount = async (req, res) => {
  try {
    res.json(await svc.reactivateAccount({ customerId: req.customer.id }));
  } catch (e) {
    console.error('[profileController.reactivateAccount] ERROR:', e.message);
    res.status(e.status || 500).json({ message: e.message });
  }
};

export const debugProfile = async (_req, res) => {
  const results = {};
  try {
    await db.query('SELECT 1');
    results.db_connection = 'OK';
  } catch (e) {
    results.db_connection = 'FAILED: ' + e.message;
  }
  try {
    const [rows] = await db.query(`SELECT column_name AS "Field" FROM information_schema.columns WHERE table_name = 'customer'`);
    results.customer_columns = rows.map(r => r.Field);
  } catch (e) {
    results.customer_columns = 'FAILED: ' + e.message;
  }
  try {
    const [rows] = await db.query('SELECT COUNT(*) AS cnt FROM customer');
    results.customer_row_count = rows[0].cnt;
  } catch (e) {
    results.customer_row_count = 'FAILED: ' + e.message;
  }
  res.json(results);
};