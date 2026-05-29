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
      SELECT COUNT(DISTINCT ch.customer_id) FROM campaign_hold ch
      JOIN campaign c ON c.product_id = p.id AND c.id = ch.campaign_id
      WHERE c.status = 'ACTIVE'
    ), 0) AS current_hold
    FROM product p LEFT JOIN review r ON r.product_id = p.id
    WHERE p.active = 1 AND p.stock_quantity > 0`;
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
       SELECT COUNT(DISTINCT ch.customer_id) FROM campaign_hold ch
       JOIN campaign c ON c.product_id = p.id AND c.id = ch.campaign_id
       WHERE c.status = 'ACTIVE'
     ), 0) AS current_hold
     FROM product p LEFT JOIN review r ON r.product_id = p.id
     WHERE p.id = ? GROUP BY p.id`,
    [productId]
  );
  return rows[0] ? toProduct(rows[0]) : null;
};

export const getCategories = async () => {
  const [rows] = await db.query('SELECT DISTINCT category FROM product WHERE active = 1 ORDER BY category');
  return rows.map(r => r.category).filter(Boolean);
};

export const getFeaturedProducts = async () => {
  const [rows] = await db.query(
    `SELECT p.*, COALESCE(AVG(r.rating),0) AS avg_rating, COUNT(DISTINCT r.id) AS review_count,
     COALESCE((
       SELECT COUNT(DISTINCT ch.customer_id) FROM campaign_hold ch
       JOIN campaign c ON c.product_id = p.id AND c.id = ch.campaign_id
       WHERE c.status = 'ACTIVE'
     ), 0) AS current_hold
     FROM product p LEFT JOIN review r ON r.product_id = p.id
     WHERE p.active = 1 AND p.stock_quantity > 0
     GROUP BY p.id ORDER BY avg_rating DESC, p.id DESC LIMIT 8`
  );
  return rows.map(toProduct);
};