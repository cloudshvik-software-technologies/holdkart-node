import db from '../config/db.js';

const parseImages = (raw) => {
  if (!raw) return [];
  if (String(raw).startsWith('[')) { try { return JSON.parse(raw).filter(Boolean); } catch {} }
  return [raw];
};

const parseSpecs = (raw) => {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return {}; }
};

const toProduct = (p) => {
  const images = parseImages(p.image_url);
  const currentHold    = Number(p.current_hold) || 0;
  const stock          = Number(p.stock_quantity) || 0;
  const remainingStock = Math.max(0, stock - currentHold);
  const hasCampaign    = Number(p.has_campaign) === 1;
  return {
    productId: p.id, sellerId: p.seller_id, sellerName: p.seller_name || null,
    name: p.product_name, description: p.description, category: p.category,
    imageUrl: images[0] || null, images,
    retailPrice: Number(p.campaign_retail_price) || p.retail_price,
    // Only expose group-deal pricing/target when the product actually has an ACTIVE campaign.
    // Without this gate, products fall back to their static product.hold_price/hold_target
    // (set by the seller at creation time) and would incorrectly show the "Join Deal" button
    // even when no campaign is running.
    holdPrice:   hasCampaign ? (Number(p.campaign_hold_price)  || p.hold_price) : null,
    holdTarget:  hasCampaign ? (Number(p.campaign_hold_target) || p.hold_target) : 0,
    currentHold,
    hasCampaign,
    stock, remainingStock, active: Boolean(p.active),
    warehouseLocation: p.warehouse_location,
    avgRating: Number(p.avg_rating) || 0, reviewCount: Number(p.review_count) || 0,
    specs: parseSpecs(p.specs),
  };
};

// Shared campaign-aware SELECT fragment reused across all queries
const PRODUCT_SELECT = `SELECT p.*,
  COALESCE(AVG(r.rating),0) AS avg_rating, COUNT(DISTINCT r.id) AS review_count,
  COALESCE((
    SELECT COUNT(ch.id) FROM campaign_hold ch
    JOIN campaign c ON c.product_id = p.id AND c.id = ch.campaign_id
    WHERE c.status = 'ACTIVE'
  ), 0) AS current_hold,
  EXISTS (
    SELECT 1 FROM campaign c3 WHERE c3.product_id = p.id AND c3.status = 'ACTIVE'
  ) AS has_campaign,
  (SELECT c4.hold_price   FROM campaign c4 WHERE c4.product_id = p.id AND c4.status = 'ACTIVE' AND c4.hold_price > 0 LIMIT 1) AS campaign_hold_price,
  (SELECT c4.target       FROM campaign c4 WHERE c4.product_id = p.id AND c4.status = 'ACTIVE' AND c4.target > 0 LIMIT 1) AS campaign_hold_target,
  (SELECT c4.retail_price FROM campaign c4 WHERE c4.product_id = p.id AND c4.status = 'ACTIVE' LIMIT 1) AS campaign_retail_price
  FROM product p LEFT JOIN review r ON r.product_id = p.id
  WHERE p.active = 1 AND p.stock_quantity > 0`;

export const listProducts = async ({ search, category, minPrice, maxPrice, rating, page = 1, limit = 20 }) => {
  let sql = PRODUCT_SELECT;
  const params = [];
  if (search)   { sql += ' AND p.product_name LIKE ?'; params.push(`%${search}%`); }
  if (category) { sql += ' AND p.category = ?';        params.push(category); }
  if (minPrice) { sql += ' AND p.retail_price >= ?';   params.push(minPrice); }
  if (maxPrice) { sql += ' AND p.retail_price <= ?';   params.push(maxPrice); }
  sql += ' GROUP BY p.id';
  // avg_rating is an aggregate alias, so the rating filter has to be a HAVING clause, not WHERE
  if (rating) { sql += ' HAVING avg_rating >= ?'; params.push(Number(rating)); }
  sql += ' ORDER BY p.id DESC LIMIT ? OFFSET ?';
  const offset = (Number(page) - 1) * Number(limit);
  params.push(Number(limit), offset);
  const [rows] = await db.query(sql, params);
  return rows.map(toProduct);
};

export const getProduct = async (productId) => {
  const [rows] = await db.query(
    `SELECT p.*, s.business_name AS seller_name,
     COALESCE(AVG(r.rating),0) AS avg_rating, COUNT(DISTINCT r.id) AS review_count,
     COALESCE((
       SELECT COUNT(ch.id) FROM campaign_hold ch
       JOIN campaign c ON c.product_id = p.id AND c.id = ch.campaign_id
       WHERE c.status = 'ACTIVE'
     ), 0) AS current_hold,
     EXISTS (
       SELECT 1 FROM campaign c3 WHERE c3.product_id = p.id AND c3.status = 'ACTIVE'
     ) AS has_campaign,
     (SELECT c4.hold_price FROM campaign c4 WHERE c4.product_id = p.id AND c4.status = 'ACTIVE' AND c4.hold_price > 0 LIMIT 1) AS campaign_hold_price,
     (SELECT c4.target FROM campaign c4 WHERE c4.product_id = p.id AND c4.status = 'ACTIVE' AND c4.target > 0 LIMIT 1) AS campaign_hold_target,
     (SELECT c4.retail_price FROM campaign c4 WHERE c4.product_id = p.id AND c4.status = 'ACTIVE' LIMIT 1) AS campaign_retail_price
     FROM product p
     LEFT JOIN seller s ON s.id = p.seller_id
     LEFT JOIN review r ON r.product_id = p.id
     WHERE p.id = ? AND p.active = 1
     GROUP BY p.id`,
    [productId]
  );
  return rows[0] ? toProduct(rows[0]) : null;
};

const SELLER_CATEGORIES = [
  'Automotive', 'Beauty', 'Books', 'Electronics', 'Fashion',
  'Grocery', 'Health', 'Home & Kitchen', 'Other', 'Sports',
  'Sports & Fitness', 'Toys', 'Toys & Games',
];

export const getCategories = async () => SELLER_CATEGORIES;

export const getFeaturedProducts = async ({ page = 1, limit = 10 } = {}) => {
  const offset = (Number(page) - 1) * Number(limit);
  const [rows] = await db.query(
    `${PRODUCT_SELECT} GROUP BY p.id ORDER BY avg_rating DESC, p.id DESC LIMIT ? OFFSET ?`,
    [Number(limit), offset]
  );
  return rows.map(toProduct);
};

// ── Ensure browsing_history table exists (auto-migration) ─────────────────────
export const ensureBrowsingHistoryTable = async () => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS browsing_history (
      id            BIGINT AUTO_INCREMENT PRIMARY KEY,
      customer_id   INT NOT NULL,
      product_id    INT NOT NULL,
      viewed_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_customer_product (customer_id, product_id),
      INDEX idx_viewed (viewed_at)
    )
  `);
};

// ── Track a product view ──────────────────────────────────────────────────────
export const trackProductView = async (customerId, productId) => {
  try {
    await ensureBrowsingHistoryTable();
    await db.query(`
      INSERT INTO browsing_history (customer_id, product_id, viewed_at)
      VALUES (?, ?, NOW())
      ON DUPLICATE KEY UPDATE viewed_at = NOW()
    `, [customerId, productId]);
    // Prune: keep last 50 views per customer
    await db.query(`
      DELETE FROM browsing_history
      WHERE customer_id = ?
        AND id NOT IN (
          SELECT id FROM (
            SELECT id FROM browsing_history
            WHERE customer_id = ?
            ORDER BY viewed_at DESC
            LIMIT 50
          ) tmp
        )
    `, [customerId, customerId]);
  } catch {
    // Non-critical — silently ignore
  }
};

// ── Personalized: Inspired by browsing history ────────────────────────────────
export const getPersonalizedBrowsing = async (customerId, limit = 14) => {
  try {
    await ensureBrowsingHistoryTable();

    // Step 1: find the categories the customer has browsed most
    const [catRows] = await db.query(`
      SELECT p.category, COUNT(*) AS cnt
      FROM browsing_history bh
      JOIN product p ON p.id = bh.product_id
      WHERE bh.customer_id = ?
        AND bh.viewed_at > DATE_SUB(NOW(), INTERVAL 30 DAY)
      GROUP BY p.category
      ORDER BY cnt DESC
      LIMIT 5
    `, [customerId]);

    // Step 2: get all viewed product ids (to prioritise exclusion, not hard exclusion)
    const [viewedRows] = await db.query(`
      SELECT DISTINCT product_id FROM browsing_history WHERE customer_id = ?
    `, [customerId]);
    const viewedIds = viewedRows.map(r => r.product_id);
    const excludePlaceholders = viewedIds.length ? viewedIds.map(() => '?').join(',') : '0';

    let results = [];

    if (catRows.length > 0) {
      const categories = catRows.map(r => r.category);
      const catPlaceholders = categories.map(() => '?').join(',');

      // Step 3a: products in browsed categories, excluding already-viewed ones
      const [fresh] = await db.query(
        `${PRODUCT_SELECT}
         AND p.category IN (${catPlaceholders})
         AND p.id NOT IN (${excludePlaceholders})
         GROUP BY p.id
         ORDER BY avg_rating DESC, p.id DESC
         LIMIT ?`,
        [...categories, ...viewedIds, Number(limit)]
      );
      results = fresh;

      // Step 3b: not enough? Include already-viewed products from those categories too
      if (results.length < Number(limit)) {
        const need = Number(limit) - results.length;
        const alreadyIds = results.map(r => r.id);
        const skipIds = [...alreadyIds];
        const skipPlaceholders = skipIds.length ? skipIds.map(() => '?').join(',') : '0';
        const [more] = await db.query(
          `${PRODUCT_SELECT}
           AND p.category IN (${catPlaceholders})
           AND p.id NOT IN (${skipPlaceholders})
           GROUP BY p.id
           ORDER BY avg_rating DESC, p.id DESC
           LIMIT ?`,
          [...categories, ...skipIds, need]
        );
        results = [...results, ...more];
      }
    }

    // Step 4: still not enough? Fill remaining slots with top-rated products from ANY category
    if (results.length < Number(limit)) {
      const need = Number(limit) - results.length;
      const alreadyIds = results.map(r => r.id);
      const skipIds = [...alreadyIds, ...viewedIds];
      const skipPlaceholders = skipIds.length ? skipIds.map(() => '?').join(',') : '0';

      const [trending] = await db.query(
        `${PRODUCT_SELECT}
         AND p.id NOT IN (${skipPlaceholders})
         GROUP BY p.id
         ORDER BY avg_rating DESC, current_hold DESC, p.id DESC
         LIMIT ?`,
        [...skipIds, need]
      );
      results = [...results, ...trending];
    }

    // Step 5: absolute fallback — if zero results (no active campaigns etc), return trending
    if (results.length === 0) {
      const [fallback] = await db.query(
        `${PRODUCT_SELECT}
         GROUP BY p.id
         ORDER BY avg_rating DESC, current_hold DESC, p.id DESC
         LIMIT ?`,
        [Number(limit)]
      );
      return fallback.map(toProduct);
    }

    return results.map(toProduct);
  } catch {
    return [];
  }
};

// ── Personalized: Based on your cart ─────────────────────────────────────────
export const getPersonalizedCart = async (customerId, limit = 14) => {
  try {
    const [cartRows] = await db.query(`
      SELECT DISTINCT p.category
      FROM cart ci
      JOIN product p ON p.id = ci.product_id
      WHERE ci.customer_id = ?
    `, [customerId]);

    if (!cartRows.length) return [];

    const categories         = cartRows.map(r => r.category);
    const catPlaceholders    = categories.map(() => '?').join(',');

    const [cartProductRows]  = await db.query(`
      SELECT DISTINCT product_id FROM cart WHERE customer_id = ?
    `, [customerId]);
    const cartProductIds     = cartProductRows.map(r => r.product_id);
    const excludePlaceholders = cartProductIds.length ? cartProductIds.map(() => '?').join(',') : '0';

    const [rows] = await db.query(
      `${PRODUCT_SELECT}
       AND p.category IN (${catPlaceholders})
       AND p.id NOT IN (${excludePlaceholders})
       GROUP BY p.id
       ORDER BY avg_rating DESC, p.id DESC
       LIMIT ?`,
      [...categories, ...cartProductIds, Number(limit)]
    );

    return rows.map(toProduct);
  } catch {
    return [];
  }
};

// ── Personalized: Suggested for you ──────────────────────────────────────────
export const getPersonalizedSuggested = async (customerId, limit = 14) => {
  try {
    await ensureBrowsingHistoryTable();

    // Top browsed categories
    const [browseRows] = await db.query(`
      SELECT p.category, COUNT(*) AS cnt
      FROM browsing_history bh
      JOIN product p ON p.id = bh.product_id
      WHERE bh.customer_id = ?
        AND bh.viewed_at > DATE_SUB(NOW(), INTERVAL 60 DAY)
      GROUP BY p.category
      ORDER BY cnt DESC
      LIMIT 5
    `, [customerId]);

    // Order history categories (wrapped individually so a missing table doesn't crash)
    let orderCategoryRows = [];
    try {
      const [r] = await db.query(`
        SELECT DISTINCT p.category
        FROM orders o
        JOIN order_item oi ON oi.order_id = o.id
        JOIN product p ON p.id = oi.product_id
        WHERE o.customer_id = ?
        ORDER BY o.id DESC
        LIMIT 20
      `, [customerId]);
      orderCategoryRows = Array.isArray(r) ? r : [];
    } catch { /* ignore if orders table differs */ }

    const categorySet = new Set([
      ...browseRows.map(r => r.category),
      ...orderCategoryRows.map(r => r.category),
    ]);

    // Products to exclude: already ordered or already in cart
    let orderedIds = [];
    try {
      const [r] = await db.query(`
        SELECT DISTINCT oi.product_id
        FROM orders o JOIN order_item oi ON oi.order_id = o.id
        WHERE o.customer_id = ?
      `, [customerId]);
      orderedIds = Array.isArray(r) ? r.map(x => x.product_id) : [];
    } catch { /* ignore */ }

    let cartIds = [];
    try {
      const [r] = await db.query(`
        SELECT DISTINCT product_id FROM cart WHERE customer_id = ?
      `, [customerId]);
      cartIds = Array.isArray(r) ? r.map(x => x.product_id) : [];
    } catch { /* ignore */ }

    const excludeIds = [...orderedIds, ...cartIds];

    if (categorySet.size > 0) {
      const cats              = [...categorySet];
      const catPlaceholders   = cats.map(() => '?').join(',');
      const excludePlaceholders = excludeIds.length ? excludeIds.map(() => '?').join(',') : '0';

      const [rows] = await db.query(
        `${PRODUCT_SELECT}
         AND p.category IN (${catPlaceholders})
         AND p.id NOT IN (${excludePlaceholders})
         GROUP BY p.id
         ORDER BY avg_rating DESC, p.id DESC
         LIMIT ?`,
        [...cats, ...excludeIds, Number(limit)]
      );

      if (rows.length >= 4) return rows.map(toProduct);
    }

    // Fallback: top-rated products overall
    const [rows] = await db.query(
      `${PRODUCT_SELECT} GROUP BY p.id ORDER BY avg_rating DESC, p.id DESC LIMIT ?`,
      [Number(limit)]
    );
    return rows.map(toProduct);
  } catch {
    return [];
  }
};

// ── Guest sections: publicly ranked, no personalisation ──────────────────────
// type: 'deals' | 'trending' | 'top_rated'
export const getGuestSectionProducts = async (sectionType, limit = 14) => {
  try {
    let orderBy;
    let extraWhere = '';
    if (sectionType === 'trending') {
      orderBy = 'current_hold DESC, p.id DESC';
    } else if (sectionType === 'deals') {
      orderBy = 'campaign_hold_target DESC, avg_rating DESC, p.id DESC';
      // This section is specifically meant to showcase running group deals,
      // so (unlike general listings) it still requires an active campaign.
      extraWhere = ` AND EXISTS (
        SELECT 1 FROM campaign c2 WHERE c2.product_id = p.id AND c2.status = 'ACTIVE' AND c2.target > 0
      )`;
    } else {
      // top_rated (default)
      orderBy = 'avg_rating DESC, review_count DESC, p.id DESC';
    }

    const [rows] = await db.query(
      `${PRODUCT_SELECT}${extraWhere} GROUP BY p.id ORDER BY ${orderBy} LIMIT ?`,
      [Number(limit)]
    );
    return rows.map(toProduct);
  } catch {
    return [];
  }
};

export const getDeliveryEstimate = async (productId, pincode) => {
  if (!pincode || !/^[1-9][0-9]{5}$/.test(String(pincode).trim())) {
    return { estimatedDate: null, error: 'Invalid pincode' };
  }
  try {
    const BASE_URL = 'https://apiv2.shiprocket.in/v1/external';
    const authRes = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: process.env.SHIPROCKET_EMAIL, password: process.env.SHIPROCKET_PASSWORD }),
    });
    const authData = await authRes.json();
    if (!authData.token) return { estimatedDate: null, error: 'Shiprocket auth failed' };

    const svcRes = await fetch(
      `${BASE_URL}/courier/serviceability/?pickup_postcode=${process.env.SHIPROCKET_PICKUP_PINCODE || '641001'}&delivery_postcode=${pincode}&weight=0.5&cod=0`,
      { headers: { Authorization: `Bearer ${authData.token}` } }
    );
    const svcData = await svcRes.json();
    const couriers = svcData?.data?.available_courier_companies || [];
    if (!couriers.length) return { estimatedDate: null, error: 'Not serviceable' };

    const etds = couriers.map(c => c.etd).filter(Boolean).sort();
    return { estimatedDate: etds[0] || null };
  } catch (e) {
    return { estimatedDate: null, error: e.message };
  }
};