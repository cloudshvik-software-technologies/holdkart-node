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
  /*
   * Use a subquery to find at most ONE active campaign per product for this
   * customer. The old JOIN on product_id alone caused one cart row to multiply
   * into N rows when the customer had campaign_hold entries in multiple past
   * rounds for the same product.
   */
  const [rows] = await db.query(
    `SELECT
       c.id            AS cartId,
       c.quantity,
       c.product_id    AS productId,
       c.added_date,
       p.product_name  AS name,
       p.retail_price  AS retailPrice,
       p.hold_price    AS holdPrice,
       p.image_url,
       p.stock_quantity AS stock,
       p.category,
       p.hold_target   AS holdTarget,
       -- Subquery: find the single active campaign this customer is currently in
       -- for this product (if any). Returns NULL columns when not in one.
       (SELECT camp.id
          FROM campaign_hold ch2
          JOIN campaign camp ON camp.id = ch2.campaign_id
         WHERE ch2.customer_id = c.customer_id
           AND ch2.product_id  = c.product_id
           AND camp.status = 'ACTIVE'
           AND (camp.end_time IS NULL OR camp.end_time > NOW())
         LIMIT 1)                    AS campaignId,
       (SELECT camp.current_hold
          FROM campaign_hold ch2
          JOIN campaign camp ON camp.id = ch2.campaign_id
         WHERE ch2.customer_id = c.customer_id
           AND ch2.product_id  = c.product_id
           AND camp.status = 'ACTIVE'
           AND (camp.end_time IS NULL OR camp.end_time > NOW())
         LIMIT 1)                    AS campaignCurrentHold,
       (SELECT camp.target
          FROM campaign_hold ch2
          JOIN campaign camp ON camp.id = ch2.campaign_id
         WHERE ch2.customer_id = c.customer_id
           AND ch2.product_id  = c.product_id
           AND camp.status = 'ACTIVE'
           AND (camp.end_time IS NULL OR camp.end_time > NOW())
         LIMIT 1)                    AS campaignTarget
     FROM cart c
     JOIN product p ON p.id = c.product_id
     WHERE c.customer_id = ?`,
    [customerId]
  );

  return rows.map(r => {
    const hasGroupDeal   = Boolean(r.campaignId);
    const safeHold       = hasGroupDeal ? Math.min(Number(r.campaignCurrentHold) || 0, Number(r.campaignTarget) || 0) : 0;
    const discountPct    = safeHold;                        // N joined = N% off
    const effectivePrice = discountPct > 0
      ? Math.round(r.retailPrice * (1 - discountPct / 100))
      : r.retailPrice;

    return {
      cartId:        r.cartId,
      productId:     r.productId,
      quantity:      r.quantity,
      name:          r.name,
      retailPrice:   r.retailPrice,
      holdPrice:     r.holdPrice,
      effectivePrice,
      discountPct,
      hasGroupDeal,
      campaignId:    r.campaignId || null,
      imageUrl:      parseImages(r.image_url)[0] || null,
      stock:         r.stock,
      category:      r.category,
      subtotal:      effectivePrice * r.quantity,
    };
  });
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