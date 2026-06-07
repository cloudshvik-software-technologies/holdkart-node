import db from '../config/db.js';

/**
 * Check if a customer has purchased a given product (any delivered/completed order).
 * Returns { canReview, orderId } — orderId is the most recent qualifying order.
 */
export const canReview = async ({ customerId, productId }) => {
  const [rows] = await db.query(
    `SELECT id FROM orders
     WHERE customer_id = ? AND product_id = ?
       AND order_status NOT IN ('Cancelled')
     ORDER BY created_date DESC
     LIMIT 1`,
    [customerId, productId]
  );
  if (!rows.length) return { canReview: false, orderId: null };
  return { canReview: true, orderId: rows[0].id };
};

/**
 * Add or update a review. Only customers who have purchased the product may submit.
 * Accepts an optional array of image paths (already saved by multer).
 */
export const addReview = async ({ customerId, productId, rating, comment, imagePaths = [] }) => {
  // Verify purchase
  const { canReview: allowed, orderId } = await canReview({ customerId, productId });
  if (!allowed) {
    throw Object.assign(new Error('You can only review products you have purchased.'), { status: 403 });
  }

  // Upsert the review
  const [result] = await db.query(
    `INSERT INTO review (customer_id, product_id, order_id, rating, comment)
     VALUES (?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       rating   = VALUES(rating),
       comment  = VALUES(comment),
       order_id = VALUES(order_id)`,
    [customerId, productId, orderId, rating, comment || '']
  );

  // Resolve review id (insert or existing)
  let reviewId;
  if (result.insertId && result.insertId > 0) {
    reviewId = result.insertId;
  } else {
    const [existing] = await db.query(
      'SELECT id FROM review WHERE customer_id = ? AND product_id = ?',
      [customerId, productId]
    );
    reviewId = existing[0]?.id;
  }

  // Remove old images for this review before inserting new ones (upsert behaviour)
  if (reviewId) {
    await db.query('DELETE FROM review_image WHERE review_id = ?', [reviewId]);
    for (const imgPath of imagePaths) {
      await db.query(
        'INSERT INTO review_image (review_id, image_path) VALUES (?,?)',
        [reviewId, imgPath]
      );
    }
  }

  return { message: 'Review submitted' };
};

/**
 * Get the authenticated customer's review for a specific product (by order id).
 */
export const getMyReview = async ({ customerId, orderId }) => {
  const [rows] = await db.query(
    `SELECT r.*, c.name AS customerName
     FROM review r
     JOIN customer c ON c.id = r.customer_id
     WHERE r.customer_id = ? AND r.order_id = ?
     LIMIT 1`,
    [customerId, orderId]
  );
  if (!rows.length) return null;
  const review = rows[0];
  const [imgs] = await db.query(
    'SELECT image_path FROM review_image WHERE review_id = ? ORDER BY id ASC',
    [review.id]
  );
  review.images = imgs.map(i => i.image_path);
  return review;
};

/**
 * Delete a review — only the owning customer may delete.
 */
export const deleteReview = async ({ customerId, reviewId }) => {
  const [rows] = await db.query(
    'SELECT id FROM review WHERE id = ? AND customer_id = ?',
    [reviewId, customerId]
  );
  if (!rows.length) {
    throw Object.assign(new Error('Review not found or not yours.'), { status: 404 });
  }
  await db.query('DELETE FROM review_image WHERE review_id = ?', [reviewId]);
  await db.query('DELETE FROM review WHERE id = ?', [reviewId]);
  return { message: 'Review deleted' };
};

export const getProductReviews = async (productId) => {
  const [rows] = await db.query(
    `SELECT r.*, c.name AS customerName
     FROM review r
     JOIN customer c ON c.id = r.customer_id
     WHERE r.product_id = ?
     ORDER BY r.created_date DESC`,
    [productId]
  );

  // Attach images to each review
  for (const row of rows) {
    const [imgs] = await db.query(
      'SELECT image_path FROM review_image WHERE review_id = ? ORDER BY id ASC',
      [row.id]
    );
    row.images = imgs.map(i => i.image_path);
  }

  return rows;
};