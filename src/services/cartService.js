import db from '../config/db.js';

const parseImages = (raw) => {
  if (!raw) return [];
  if (String(raw).startsWith('[')) { try { return JSON.parse(raw).filter(Boolean); } catch {} }
  return [raw];
};

export const addToCart = async ({ customerId, productId, quantity = 1 }) => {
  // Manual "Add to Cart" always goes in as REGULAR price row.
  // The unique key is (customer_id, product_id, price_type), so this
  // never collides with a DEAL row for the same product.
  await db.query(
    `INSERT INTO cart (customer_id, product_id, quantity, price_type, locked_price)
     VALUES (?, ?, ?, 'REGULAR', NULL)
     ON DUPLICATE KEY UPDATE quantity = quantity + ?`,
    [customerId, productId, quantity, quantity]
  );
  return { message: 'Added to cart' };
};

export const getCart = async (customerId) => {
  const [rows] = await db.query(
    `SELECT
       c.id             AS cartId,
       c.quantity,
       c.product_id     AS productId,
       c.price_type     AS priceType,
       c.added_date,
       c.locked_price   AS lockedPrice,
       c.deposit_paid   AS depositPaid,
       p.product_name   AS name,
       p.retail_price   AS retailPrice,
       p.hold_price     AS holdPrice,
       p.image_url,
       p.stock_quantity AS stock,
       p.category,
       p.hold_target    AS holdTarget
     FROM cart c
     JOIN product p ON p.id = c.product_id AND p.active = 1
     WHERE c.customer_id = ?
     ORDER BY c.added_date DESC`,
    [customerId]
  );

  return rows.map(r => {
    const hasGroupDeal   = r.priceType === 'DEAL';
    const effectivePrice = hasGroupDeal
      ? Number(r.lockedPrice)
      : Number(r.retailPrice);
    const discountPct    = hasGroupDeal
      ? Math.round((1 - effectivePrice / Number(r.retailPrice)) * 100)
      : 0;

    return {
      cartId:        r.cartId,
      productId:     r.productId,
      priceType:     r.priceType,
      quantity:      r.quantity,
      name:          r.name,
      retailPrice:   Number(r.retailPrice),
      holdPrice:     Number(r.holdPrice),
      effectivePrice,
      discountPct,
      hasGroupDeal,
      // Actual deposit the customer paid when joining (stored at join time, not derived from qty)
      depositPaid:   hasGroupDeal ? (Number(r.depositPaid) || 0) : 0,
      imageUrl:      parseImages(r.image_url)[0] || null,
      stock:         r.stock,
      category:      r.category,
      subtotal:      effectivePrice * r.quantity,
    };
  });
};

export const updateCartItem = async ({ customerId, cartId, quantity }) => {
  // Use cartId (primary key) so we target the exact row — REGULAR or DEAL
  if (quantity <= 0) {
    await db.query('DELETE FROM cart WHERE id = ? AND customer_id = ?', [cartId, customerId]);
    return { message: 'Item removed from cart' };
  }
  await db.query(
    'UPDATE cart SET quantity = ? WHERE id = ? AND customer_id = ?',
    [quantity, cartId, customerId]
  );
  return { message: 'Cart updated' };
};

export const removeFromCart = async ({ customerId, cartId }) => {
  // Remove by cartId so only the specific row (REGULAR or DEAL) is deleted
  await db.query('DELETE FROM cart WHERE id = ? AND customer_id = ?', [cartId, customerId]);
  return { message: 'Removed from cart' };
};

export const clearCart = async (customerId) => {
  await db.query('DELETE FROM cart WHERE customer_id = ?', [customerId]);
  return { message: 'Cart cleared' };
};