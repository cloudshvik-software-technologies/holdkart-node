import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import http from 'http';
import https from 'https';

import authRoutes         from './routes/auth.js';
import productRoutes      from './routes/product.js';
import cartRoutes         from './routes/cart.js';
import wishlistRoutes     from './routes/wishlist.js';
import orderRoutes        from './routes/orders.js';
import profileRoutes      from './routes/profile.js';
import notificationRoutes from './routes/notifications.js';
import complaintRoutes    from './routes/complaints.js';
import reviewRoutes       from './routes/review.js';
import campaignRoutes     from './routes/campaign.js';
import paymentRoutes      from './routes/payment.js';
import { notFound, errorHandler } from './middleware/errorHandler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();

// ── Core middleware ────────────────────────────────────────────────────────────
app.use(cors({ origin: '*', maxAge: 3600 }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ── Customer's own uploads (profile images etc.) ──────────────────────────────
const uploadsPath = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(uploadsPath, { recursive: true });
app.use('/uploads', express.static(uploadsPath));

// ── Seller uploads proxy ───────────────────────────────────────────────────────
// Product images are stored in the seller backend's uploads folder.
// We expose them under /seller-uploads/* so the browser only ever talks
// to the customer backend (port 8081) — no cross-origin port juggling.
//
// Option A (same machine): set SELLER_UPLOADS_PATH in .env to the absolute
//   path of the seller's uploads folder for direct disk serving (fastest).
//   e.g.  SELLER_UPLOADS_PATH=C:\projects\holdkart-seller-node\uploads
//         SELLER_UPLOADS_PATH=/home/user/holdkart-seller-node/uploads
//
// Option B (default): HTTP proxy to SELLER_BACKEND_URL (works always).
const sellerUploadsPath = process.env.SELLER_UPLOADS_PATH;
const sellerBackendUrl  = process.env.SELLER_BACKEND_URL || 'http://localhost:8080';

if (sellerUploadsPath && fs.existsSync(sellerUploadsPath)) {
  // Direct static serve — zero latency, no network hop
  console.log(`[seller-uploads] Serving from disk: ${sellerUploadsPath}`);
  app.use('/seller-uploads', express.static(sellerUploadsPath));
} else {
  // HTTP proxy — streams the file from the seller backend
  console.log(`[seller-uploads] Proxying to: ${sellerBackendUrl}/uploads/*`);
  app.use('/seller-uploads', (req, res) => {
    const targetUrl = `${sellerBackendUrl}/uploads${req.path}`;
    const lib = targetUrl.startsWith('https') ? https : http;

    lib.get(targetUrl, (proxyRes) => {
      if (proxyRes.statusCode === 404) {
        return res.status(404).json({ message: 'Image not found' });
      }
      res.set('Content-Type',  proxyRes.headers['content-type']  || 'application/octet-stream');
      res.set('Cache-Control', 'public, max-age=86400'); // cache 1 day in browser
      res.set('Access-Control-Allow-Origin', '*');
      res.status(proxyRes.statusCode || 200);
      proxyRes.pipe(res);
    }).on('error', (err) => {
      console.error('[seller-uploads proxy]', err.message);
      res.status(502).json({ message: 'Could not fetch image from seller backend' });
    });
  });
}

// ── API Routes ─────────────────────────────────────────────────────────────────
app.use('/api/customer/auth',          authRoutes);
app.use('/api/customer/product',       productRoutes);
app.use('/api/customer/cart',          cartRoutes);
app.use('/api/customer/wishlist',      wishlistRoutes);
app.use('/api/customer/orders',        orderRoutes);
app.use('/api/customer/profile',       profileRoutes);
app.use('/api/customer/notifications', notificationRoutes);
app.use('/api/customer/complaints',    complaintRoutes);
app.use('/api/customer/review',        reviewRoutes);
app.use('/api/customer/campaign',      campaignRoutes);
app.use('/api/customer/payment',       paymentRoutes);

app.get('/health', (_req, res) => res.json({ status: 'OK', service: 'holdkart-customer-backend' }));

app.use(notFound);
app.use(errorHandler);

export default app;