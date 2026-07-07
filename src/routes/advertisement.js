// src/routes/advertisement.js
// Public endpoint — no auth required.

import { Router } from 'express';
import db from '../config/db.js';

const router = Router();

const CUSTOMER_URL = process.env.CUSTOMER_BACKEND_URL || 'http://localhost:8081';

// DB stores image_url as:  /uploads/advertisements/file.webp
// Seller-uploads proxy:    /seller-uploads/advertisements/file.webp
function resolveImageUrl(imageUrl) {
  if (!imageUrl) return null;
  if (imageUrl.startsWith('http')) return imageUrl;
  const stripped = imageUrl.replace(/^\/uploads/, '');
  return `${CUSTOMER_URL}/seller-uploads${stripped}`;
}

// GET /api/customer/ads/active?type=hero_banner
router.get('/active', async (req, res) => {
  try {
    const { type } = req.query;

    // Match on payment_status = 'paid'.
    // Date check is skipped when start_date/end_date are NULL
    // (happens when seller payment succeeded but status update had a partial failure).
    let query = `
      SELECT id, title, description, redirect_url, ad_type, image_url,
             duration_days, start_date, end_date
      FROM seller_advertisement
      WHERE payment_status = 'paid'
        AND status NOT IN ('cancelled', 'expired')
        AND (start_date IS NULL OR start_date <= DATE(NOW()))
        AND (end_date   IS NULL OR end_date   >= DATE(NOW()))
    `;
    const params = [];

    if (type) {
      query += ' AND ad_type = ?';
      params.push(type);
    }

    query += ' ORDER BY RANDOM()';

    const [rows] = await db.query(query, params);

    // For any ad with NULL dates, fix them in the DB on the fly
    for (const row of rows) {
      if (!row.start_date || !row.end_date) {
        const days = row.duration_days || 7;
        await db.query(
          `UPDATE seller_advertisement
           SET status = 'active', start_date = DATE(NOW()), end_date = DATE(NOW()) + (? * INTERVAL '1 day')
           WHERE id = ? AND start_date IS NULL`,
          [days, row.id]
        );
      }
    }

    const ads = rows.map(r => ({
      id:          r.id,
      title:       r.title,
      description: r.description,
      redirectUrl: r.redirect_url,
      adType:      r.ad_type,
      imageUrl:    resolveImageUrl(r.image_url),
    }));

    res.json({ success: true, data: ads });
  } catch (err) {
    console.error('[ads/active] ERROR:', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch advertisements' });
  }
});

export default router;