// src/config/s3.js
//
// Central S3 client + helpers for all customer-side uploads (profile images,
// review images). Mirrors the seller backend's src/config/s3.js exactly, so
// both services share one bucket safely.
//
// KEY / PATH SCHEME (shared across the customer, seller, and admin backends):
//
//   {project}/{category}/{entityId}/{uuid}.{ext}
//
// e.g.
//   customer/profile-images/{customerId}/{uuid}.jpg
//   customer/review-images/{productId}/{customerId}/{uuid}.jpg
//
// `project` ('customer' here) is the top-level partition and also the IAM
// security boundary — this backend's IAM user/role should only be able to
// read/write under `customer/*`, so it can never touch seller/admin objects
// even sharing one bucket.

import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import env from './env.js';

const PROJECT = 'customer';

export const s3 = new S3Client({
  region: env.s3.region,
  credentials: env.s3.accessKeyId && env.s3.secretAccessKey
    ? { accessKeyId: env.s3.accessKeyId, secretAccessKey: env.s3.secretAccessKey }
    : undefined, // falls back to the default credential chain (e.g. an EC2/ECS IAM role)
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_UPLOADS_DIR = path.join(__dirname, '..', '..', 'uploads');
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8081';

const publicUrlFor = (key) => {
  if (env.s3.publicBaseUrl) {
    return `${env.s3.publicBaseUrl.replace(/\/$/, '')}/${key}`;
  }
  return `https://${env.s3.bucket}.s3.${env.s3.region}.amazonaws.com/${key}`;
};

/**
 * Builds a namespaced S3 key following the shared {project}/{category}/{entityId}/{uuid}.{ext}
 * scheme described above.
 */
export const buildKey = (category, entityId, originalName) => {
  const ext = (originalName.match(/\.[a-zA-Z0-9]+$/) || [''])[0].toLowerCase();
  return `${PROJECT}/${category}/${entityId}/${randomUUID()}${ext}`;
};

/**
 * Uploads a buffer (as produced by multer.memoryStorage()) to S3 and
 * returns the public URL to store in the DB / return to the frontend.
 *
 * FIX: previously this let any S3/AWS SDK error (most commonly
 * CredentialsProviderError: "Could not load credentials from any
 * providers" when no AWS keys are configured, e.g. local/dev) bubble all
 * the way up through the controller's generic catch block and out to the
 * customer as a raw, internal error message — e.g. when submitting a
 * return/replace request with evidence photos, the customer would see
 * "Could not load credentials from any providers" instead of their request
 * succeeding or a sensible error. Now any upload failure — missing
 * credentials, network issue, wrong bucket, etc. — transparently falls
 * back to local disk storage (served from the existing legacy `/uploads`
 * static route already wired up in app.js), so the feature keeps working
 * with zero AWS configuration, and only logs the real error server-side.
 */
export const uploadBufferToS3 = async ({ buffer, key, contentType }) => {
  try {
    await s3.send(new PutObjectCommand({
      Bucket:      env.s3.bucket,
      Key:         key,
      Body:        buffer,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
    }));
    return publicUrlFor(key);
  } catch (err) {
    console.error('[s3] upload failed, falling back to local disk:', err.message);
    return uploadBufferLocally({ buffer, key });
  }
};

/**
 * Local-disk fallback used when S3 isn't configured/reachable. Mirrors the
 * `{project}/{category}/{entityId}/{uuid}.{ext}` key scheme so keyFromUrl()
 * below and any downstream code that parses stored URLs keeps working the
 * same way regardless of which backend actually stored the file.
 */
const uploadBufferLocally = async ({ buffer, key }) => {
  const destPath = path.join(LOCAL_UPLOADS_DIR, key);
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  await fs.promises.writeFile(destPath, buffer);
  return `${BACKEND_URL}/uploads/${key}`;
};

/**
 * Deletes an object given either a full public URL (as stored in the DB)
 * or a bare key. Safe to call with legacy local paths ('/uploads/...') —
 * those simply won't match any known key pattern and will be skipped.
 */
export const deleteFromS3 = async (urlOrKey) => {
  const key = keyFromUrl(urlOrKey);
  if (!key) return;
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: env.s3.bucket, Key: key }));
  } catch (e) {
    console.error('[s3] delete failed:', e.message);
  }
};

const keyFromUrl = (urlOrKey) => {
  if (!urlOrKey) return null;
  if (urlOrKey.startsWith(`${PROJECT}/`)) return urlOrKey; // already a bare key
  const marker = `/${PROJECT}/`;
  const idx = urlOrKey.indexOf(marker);
  if (idx === -1) return null; // not an S3 URL we recognize (e.g. legacy local path)
  return urlOrKey.slice(idx + 1);
};