import db from '../config/db.js';

  const parseImages = (raw) => {
    if (!raw) return [];
    if (String(raw).startsWith('[')) { try { return JSON.parse(raw).filter(Boolean); } catch {} }
    return [raw];
  };

  export const addToWishlist = async ({ customerId, productId }) => {
    await db.query(
      'INSERT IGNORE INTO wishlist (customer_id, product_id) VALUES (?, ?)',
      [customerId, productId]
    );
    return { message: 'Added to wishlist' };
  };

  export const getWishlist = async (customerId) => {
    const [rows] = await db.query(
      `SELECT w.id, w.product_id, w.added_date,
              p.product_name AS name, p.retail_price AS retailPrice,
              p.hold_price AS holdPrice, p.image_url, p.stock_quantity AS stock,
              p.category, p.active
       FROM wishlist w JOIN product p ON p.id = w.product_id AND p.active = 1
       WHERE w.customer_id = ? ORDER BY w.added_date DESC`,
      [customerId]
    );
    return rows.map(r => ({
      wishlistId: r.id, productId: r.product_id,
      name: r.name, retailPrice: r.retailPrice, holdPrice: r.holdPrice,
      imageUrl: parseImages(r.image_url)[0] || null,
      stock: r.stock, category: r.category, active: Boolean(r.active),
    }));
  };

  export const removeFromWishlist = async ({ customerId, productId }) => {
    await db.query('DELETE FROM wishlist WHERE customer_id = ? AND product_id = ?', [customerId, productId]);
    return { message: 'Removed from wishlist' };
  };