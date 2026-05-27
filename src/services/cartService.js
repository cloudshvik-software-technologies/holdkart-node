import db from '../config/db.js';

  const parseImages = (raw) => {
    if (!raw) return [];
    if (String(raw).startsWith('[')) { try { return JSON.parse(raw).filter(Boolean); } catch {} }
    return [raw];
  };

  export const addToCart = async ({ customerId, productId, quantity = 1 }) => {
    await db.query(
      `INSERT INTO cart (customer_id, product_id, quantity) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE quantity = quantity + ?`,
      [customerId, productId, quantity, quantity]
    );
    return { message: 'Added to cart' };
  };

  export const getCart = async (customerId) => {
    const [rows] = await db.query(
      `SELECT c.id, c.quantity, c.product_id, c.added_date,
              p.product_name AS name, p.retail_price AS retailPrice,
              p.hold_price AS holdPrice, p.image_url, p.stock_quantity AS stock, p.category
       FROM cart c JOIN product p ON p.id = c.product_id
       WHERE c.customer_id = ?`,
      [customerId]
    );
    return rows.map(r => ({
      cartId: r.id, productId: r.product_id, quantity: r.quantity,
      name: r.name, retailPrice: r.retailPrice, holdPrice: r.holdPrice,
      imageUrl: parseImages(r.image_url)[0] || null,
      stock: r.stock, category: r.category,
      subtotal: r.retailPrice * r.quantity,
    }));
  };

  export const updateCartItem = async ({ customerId, productId, quantity }) => {
    if (quantity <= 0) {
      await db.query('DELETE FROM cart WHERE customer_id = ? AND product_id = ?', [customerId, productId]);
      return { message: 'Item removed from cart' };
    }
    await db.query('UPDATE cart SET quantity = ? WHERE customer_id = ? AND product_id = ?', [quantity, customerId, productId]);
    return { message: 'Cart updated' };
  };

  export const removeFromCart = async ({ customerId, productId }) => {
    await db.query('DELETE FROM cart WHERE customer_id = ? AND product_id = ?', [customerId, productId]);
    return { message: 'Removed from cart' };
  };

  export const clearCart = async (customerId) => {
    await db.query('DELETE FROM cart WHERE customer_id = ?', [customerId]);
    return { message: 'Cart cleared' };
  };
  