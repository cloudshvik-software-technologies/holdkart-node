import db from '../config/db.js';

const parseImages = (raw) => {
  if (!raw) return [];
  if (String(raw).startsWith('[')) { try { return JSON.parse(raw).filter(Boolean); } catch {} }
  return [raw];
};

const toProduct = (p) => {
  const images = parseImages(p.image_url);
  return {
    productId: p.id, sellerId: p.seller_id,
    name: p.product_name, description: p.description, category: p.category,
    imageUrl: images[0] || null, images,
    retailPrice: p.retail_price, holdPrice: p.hold_price, holdTarget: p.hold_target,
    currentHold: Number(p.current_hold) || 0,
    stock: p.stock_quantity, active: Boolean(p.active),
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
    ), 0) AS current_hold
    FROM product p LEFT JOIN review r ON r.product_id = p.id
    WHERE p.active = 1 AND p.stock_quantity > 0
    AND NOT EXISTS (
      SELECT 1 FROM campaign c2 WHERE c2.product_id = p.id AND c2.status = 'PAUSED'
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
    `SELECT p.*, COALESCE(AVG(r.rating),0) AS avg_rating, COUNT(DISTINCT r.id) AS review_count,
     COALESCE((
       SELECT COUNT(ch.id) FROM campaign_hold ch
       JOIN campaign c ON c.product_id = p.id AND c.id = ch.campaign_id
       WHERE c.status = 'ACTIVE'
     ), 0) AS current_hold
     FROM product p LEFT JOIN review r ON r.product_id = p.id
     WHERE p.id = ? AND p.active = 1 GROUP BY p.id`,
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
     ), 0) AS current_hold
     FROM product p LEFT JOIN review r ON r.product_id = p.id
     WHERE p.active = 1 AND p.stock_quantity > 0
     AND NOT EXISTS (
       SELECT 1 FROM campaign c2 WHERE c2.product_id = p.id AND c2.status = 'PAUSED'
     )
     GROUP BY p.id ORDER BY avg_rating DESC, p.id DESC LIMIT ? OFFSET ?`,
    [Number(limit), offset]
  );
  return rows.map(toProduct);
};