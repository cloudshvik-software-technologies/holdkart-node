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
import env from './env.js';

const PROJECT = 'customer';

export const s3 = new S3Client({
  region: env.s3.region,
  credentials: env.s3.accessKeyId && env.s3.secretAccessKey
    ? { accessKeyId: env.s3.accessKeyId, secretAccessKey: env.s3.secretAccessKey }
    : undefined, // falls back to the default credential chain (e.g. an EC2/ECS IAM role)
});

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
 */
export const uploadBufferToS3 = async ({ buffer, key, contentType }) => {
  await s3.send(new PutObjectCommand({
    Bucket:      env.s3.bucket,
    Key:         key,
    Body:        buffer,
    ContentType: contentType,
    CacheControl: 'public, max-age=31536000, immutable',
  }));
  return publicUrlFor(key);
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
