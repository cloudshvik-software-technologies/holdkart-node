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
   * For each cart item we also check whether this customer has joined an ACTIVE
   * group-deal campaign for that product.  If they have, we use the current
   * hold count to compute the group-deal price (N joined = N% off).
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
       -- active campaign the customer joined for this product (if any)
       camp.id              AS campaignId,
       camp.current_hold    AS campaignCurrentHold,
       camp.target          AS campaignTarget,
       camp.status          AS campaignStatus
     FROM cart c
     JOIN product p ON p.id = c.product_id
     LEFT JOIN campaign_hold ch
           ON ch.customer_id = ? AND ch.product_id = c.product_id
     LEFT JOIN campaign camp
           ON camp.id = ch.campaign_id
          AND camp.status = 'ACTIVE'
          AND (camp.end_time IS NULL OR camp.end_time > NOW())
     WHERE c.customer_id = ?`,
    [customerId, customerId]
  );

  return rows.map(r => {
    /* discount = how many people currently in that campaign (N joined = N% off) */
    const hasGroupDeal  = r.campaignId && r.campaignStatus === 'ACTIVE';
    const safeHold      = hasGroupDeal ? Math.min(Number(r.campaignCurrentHold) || 0, Number(r.campaignTarget) || 0) : 0;
    const discountPct   = safeHold;                                   // N joined = N% off
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
      effectivePrice,                    // price the customer actually pays
      discountPct,                       // 0 if no group deal
      hasGroupDeal:  Boolean(hasGroupDeal),
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
