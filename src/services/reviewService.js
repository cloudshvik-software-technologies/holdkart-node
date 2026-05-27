import db from '../config/db.js';

  export const addReview = async ({ customerId, productId, orderId, rating, comment }) => {
    await db.query(
      `INSERT INTO review (customer_id, product_id, order_id, rating, comment)
       VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE rating=VALUES(rating), comment=VALUES(comment)`,
      [customerId, productId, orderId || null, rating, comment || '']
    );
    return { message: 'Review submitted' };
  };

  export const getProductReviews = async (productId) => {
    const [rows] = await db.query(
      `SELECT r.*, c.name AS customerName
       FROM review r JOIN customer c ON c.id = r.customer_id
       WHERE r.product_id = ? ORDER BY r.created_date DESC`,
      [productId]
    );
    return rows;
  };
  