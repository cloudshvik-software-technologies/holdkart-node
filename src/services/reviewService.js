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
     ON CONFLICT (customer_id, product_id, order_id) DO UPDATE SET
       rating   = EXCLUDED.rating,
       comment  = EXCLUDED.comment`,
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
    `SELECT r.*, c.name AS "customerName"
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

export const getReviewedProducts = async (customerId) => {
  const [rows] = await db.query(
    'SELECT DISTINCT product_id FROM review WHERE customer_id = ?',
    [customerId]
  );
  return rows.map(r => String(r.product_id));
};

export const getProductReviews = async (productId, customerId = null) => {
  const [rows] = await db.query(
    `SELECT r.*, c.name AS "customerName",
            (SELECT COUNT(*) FROM review_like rl WHERE rl.review_id = r.id) AS likes
     FROM review r
     JOIN customer c ON c.id = r.customer_id
     WHERE r.product_id = ?
     ORDER BY r.created_date DESC`,
    [productId]
  );

  // Attach images and current customer's vote to each review
  for (const row of rows) {
    const [imgs] = await db.query(
      'SELECT image_path FROM review_image WHERE review_id = ? ORDER BY id ASC',
      [row.id]
    );
    row.images = imgs.map(i => i.image_path);
    row.likes = Number(row.likes) || 0;

    if (customerId) {
      const [vote] = await db.query(
        'SELECT id FROM review_like WHERE review_id = ? AND customer_id = ?',
        [row.id, customerId]
      );
      row.userVote = vote.length > 0 ? 'like' : null;
    } else {
      row.userVote = null;
    }
  }

  return rows;
};

/**
 * Toggle a like on a review. One like per customer per review.
 * Returns the new like count and the customer's current vote state.
 */
export const toggleReviewLike = async ({ customerId, reviewId }) => {
  // Ensure the review exists
  const [rev] = await db.query('SELECT id FROM review WHERE id = ?', [reviewId]);
  if (!rev.length) {
    throw Object.assign(new Error('Review not found.'), { status: 404 });
  }

  // Check if this customer already liked this review
  const [existing] = await db.query(
    'SELECT id FROM review_like WHERE review_id = ? AND customer_id = ?',
    [reviewId, customerId]
  );

  let userVote;
  if (existing.length > 0) {
    // Already liked — remove the like
    await db.query(
      'DELETE FROM review_like WHERE review_id = ? AND customer_id = ?',
      [reviewId, customerId]
    );
    userVote = null;
  } else {
    // Not yet liked — add the like
    await db.query(
      'INSERT INTO review_like (review_id, customer_id) VALUES (?, ?)',
      [reviewId, customerId]
    );
    userVote = 'like';
  }

  // Return updated total like count
  const [[{ likes }]] = await db.query(
    'SELECT COUNT(*) AS likes FROM review_like WHERE review_id = ?',
    [reviewId]
  );

  return { likes: Number(likes), userVote };
};