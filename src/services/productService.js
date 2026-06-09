import db from '../config/db.js';

const parseImages = (raw) => {
  if (!raw) return [];
  if (String(raw).startsWith('[')) { try { return JSON.parse(raw).filter(Boolean); } catch {} }
  return [raw];
};

const toProduct = (p) => {
  const images = parseImages(p.image_url);
  const currentHold    = Number(p.current_hold) || 0;
  const stock          = Number(p.stock_quantity) || 0;
  // remainingStock = units not yet committed to the active campaign's holds
  const remainingStock = Math.max(0, stock - currentHold);
  return {
    productId: p.id, sellerId: p.seller_id, sellerName: p.seller_name || null,
    name: p.product_name, description: p.description, category: p.category,
    imageUrl: images[0] || null, images,
    retailPrice: Number(p.campaign_retail_price) || p.retail_price,
    holdPrice:   Number(p.campaign_hold_price)   || p.hold_price,
    holdTarget:  Number(p.campaign_hold_target)  || p.hold_target,
    currentHold,
    hasCampaign: Number(p.has_campaign) === 1,
    stock, remainingStock, active: Boolean(p.active),
    warehouseLocation: p.warehouse_location,
    avgRating: Number(p.avg_rating) || 0, reviewCount: Number(p.review_count) || 0,
  };
};

export const listProducts = async ({ search, category, minPrice, maxPrice, page = 1, limit = 20 }) => {
  let sql = `SELECT p.*,
    COALESCE(AVG(r.rating),0) AS avg_rating, COUNT(DISTINCT r.id) AS review_count,
    COALESCE((
      SELECT COUNT(ch.id) FROM campaign_hold ch
      JOIN campaign c ON c.product_id = p.id AND c.id = ch.campaign_id
      WHERE c.status = 'ACTIVE'
    ), 0) AS current_hold,
    EXISTS (
      SELECT 1 FROM campaign c3
      WHERE c3.product_id = p.id AND c3.status = 'ACTIVE'
    ) AS has_campaign,
    (SELECT c4.hold_price FROM campaign c4 WHERE c4.product_id = p.id AND c4.status = 'ACTIVE' AND c4.hold_price > 0 LIMIT 1) AS campaign_hold_price,
    (SELECT c4.target FROM campaign c4 WHERE c4.product_id = p.id AND c4.status = 'ACTIVE' AND c4.target > 0 LIMIT 1) AS campaign_hold_target,
    (SELECT c4.retail_price FROM campaign c4 WHERE c4.product_id = p.id AND c4.status = 'ACTIVE' LIMIT 1) AS campaign_retail_price
    FROM product p LEFT JOIN review r ON r.product_id = p.id
    WHERE p.active = 1 AND p.stock_quantity > 0
    AND EXISTS (
      SELECT 1 FROM campaign c2 WHERE c2.product_id = p.id AND c2.status = 'ACTIVE'
      AND c2.target > 0
    )`;
  const params = [];
  if (search)   { sql += ' AND p.product_name LIKE ?';   params.push(`%${search}%`); }
  if (category) { sql += ' AND p.category = ?';           params.push(category); }
  if (minPrice) { sql += ' AND p.retail_price >= ?';      params.push(minPrice); }
  if (maxPrice) { sql += ' AND p.retail_price <= ?';      params.push(maxPrice); }
  sql += ' GROUP BY p.id ORDER BY p.id DESC LIMIT ? OFFSET ?';
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
       SELECT 1 FROM campaign c3
       WHERE c3.product_id = p.id AND c3.status = 'ACTIVE'
     ) AS has_campaign,
     (SELECT c4.hold_price FROM campaign c4 WHERE c4.product_id = p.id AND c4.status = 'ACTIVE' AND c4.hold_price > 0 LIMIT 1) AS campaign_hold_price,
     (SELECT c4.target FROM campaign c4 WHERE c4.product_id = p.id AND c4.status = 'ACTIVE' AND c4.target > 0 LIMIT 1) AS campaign_hold_target,
     (SELECT c4.retail_price FROM campaign c4 WHERE c4.product_id = p.id AND c4.status = 'ACTIVE' LIMIT 1) AS campaign_retail_price
     FROM product p
     LEFT JOIN seller s ON s.id = p.seller_id
     LEFT JOIN review r ON r.product_id = p.id
     WHERE p.id = ? AND p.active = 1
     AND EXISTS (
       SELECT 1 FROM campaign c2 WHERE c2.product_id = p.id AND c2.status = 'ACTIVE'
       AND c2.target > 0
     )
     GROUP BY p.id`,
    [productId]
  );
  return rows[0] ? toProduct(rows[0]) : null;
};

// Fixed seller-defined categories — must match exactly what the seller panel uses
const SELLER_CATEGORIES = [
  'Automotive', 'Beauty', 'Books', 'Electronics', 'Fashion',
  'Grocery', 'Health', 'Home & Kitchen', 'Other', 'Sports',
  'Sports & Fitness', 'Toys', 'Toys & Games',
];

export const getCategories = async () => {
  // Always return the full seller-defined category list
  return SELLER_CATEGORIES;
};

export const getFeaturedProducts = async ({ page = 1, limit = 10 } = {}) => {
  const offset = (Number(page) - 1) * Number(limit);
  const [rows] = await db.query(
    `SELECT p.*, COALESCE(AVG(r.rating),0) AS avg_rating, COUNT(DISTINCT r.id) AS review_count,
     COALESCE((
       SELECT COUNT(ch.id) FROM campaign_hold ch
       JOIN campaign c ON c.product_id = p.id AND c.id = ch.campaign_id
       WHERE c.status = 'ACTIVE'
     ), 0) AS current_hold,
     EXISTS (
       SELECT 1 FROM campaign c3
       WHERE c3.product_id = p.id AND c3.status = 'ACTIVE'
     ) AS has_campaign,
     (SELECT c4.hold_price FROM campaign c4 WHERE c4.product_id = p.id AND c4.status = 'ACTIVE' AND c4.hold_price > 0 LIMIT 1) AS campaign_hold_price,
     (SELECT c4.target FROM campaign c4 WHERE c4.product_id = p.id AND c4.status = 'ACTIVE' AND c4.target > 0 LIMIT 1) AS campaign_hold_target,
     (SELECT c4.retail_price FROM campaign c4 WHERE c4.product_id = p.id AND c4.status = 'ACTIVE' LIMIT 1) AS campaign_retail_price
     FROM product p LEFT JOIN review r ON r.product_id = p.id
     WHERE p.active = 1 AND p.stock_quantity > 0
     AND EXISTS (
       SELECT 1 FROM campaign c2 WHERE c2.product_id = p.id AND c2.status = 'ACTIVE'
       AND c2.target > 0
     )
     GROUP BY p.id ORDER BY avg_rating DESC, p.id DESC LIMIT ? OFFSET ?`,
    [Number(limit), offset]
  );
  return rows.map(toProduct);
};

export const getDeliveryEstimate = async (productId, pincode) => {
  if (!pincode || !/^[1-9][0-9]{5}$/.test(String(pincode).trim())) {
    return { estimatedDate: null, error: 'Invalid pincode' };
  }
  try {
    const BASE_URL = 'https://apiv2.shiprocket.in/v1/external';
    // Auth
    const authRes = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: process.env.SHIPROCKET_EMAIL, password: process.env.SHIPROCKET_PASSWORD }),
    });
    const authData = await authRes.json();
    if (!authData.token) return { estimatedDate: null, error: 'Shiprocket auth failed' };

    // Check serviceability
    const svcRes = await fetch(
      `${BASE_URL}/courier/serviceability/?pickup_postcode=${process.env.SHIPROCKET_PICKUP_PINCODE || '641001'}&delivery_postcode=${pincode}&weight=0.5&cod=0`,
      { headers: { Authorization: `Bearer ${authData.token}` } }
    );
    const svcData = await svcRes.json();
    const couriers = svcData?.data?.available_courier_companies || [];
    if (!couriers.length) return { estimatedDate: null, error: 'Not serviceable' };

    // Pick fastest ETD
    const etds = couriers
      .map(c => c.etd)
      .filter(Boolean)
      .sort();
    const etd = etds[0];
    return { estimatedDate: etd || null };
  } catch (e) {
    return { estimatedDate: null, error: e.message };
  }
};