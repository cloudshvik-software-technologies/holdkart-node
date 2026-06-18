import db from '../config/db.js';

const parseImages = (raw) => {
  if (!raw) return [];
  if (String(raw).startsWith('[')) { try { return JSON.parse(raw).filter(Boolean); } catch {} }
  return [raw];
};

const parseSpecs = (raw) => {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return {}; }
};

export const addToCart = async ({ customerId, productId, quantity = 1 }) => {
  // Only allow adding to cart when an ACTIVE campaign exists for this product.
  // The available quantity is total stock minus the slots already committed in
  // the current active campaign (current_hold).
  const [campaignRows] = await db.query(
    `SELECT c.id, c.current_hold, p.stock_quantity
     FROM campaign c
     JOIN product p ON p.id = c.product_id
     WHERE c.product_id = ? AND c.status = 'ACTIVE'
       AND (c.end_time IS NULL OR c.end_time > NOW())
     LIMIT 1`,
    [productId]
  );

  if (!campaignRows.length) {
    const e = new Error('This product is not available for purchase right now');
    e.status = 400;
    throw e;
  }

  const { current_hold, stock_quantity } = campaignRows[0];
  const remainingStock = Math.max(0, stock_quantity - current_hold);

  if (remainingStock <= 0) {
    const e = new Error('No stock available \u2014 all units are reserved for the active campaign');
    e.status = 400;
    throw e;
  }

  // Cap the requested quantity to the remaining available stock
  const allowedQty = Math.min(quantity, remainingStock);

  // Manual "Add to Cart" always goes in as REGULAR price row.
  // The unique key is (customer_id, product_id, price_type), so this
  // never collides with a DEAL row for the same product.
  await db.query(
    `INSERT INTO cart (customer_id, product_id, quantity, price_type, locked_price)
     VALUES (?, ?, ?, 'REGULAR', NULL)
     ON DUPLICATE KEY UPDATE quantity = quantity + ?`,
    [customerId, productId, allowedQty, allowedQty]
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
       p.hold_target    AS holdTarget,
       p.specs,
       (SELECT cam.hold_price FROM campaign cam
        WHERE cam.product_id = c.product_id AND cam.hold_price > 0
        ORDER BY cam.id DESC LIMIT 1) AS campaignHoldPrice,
       (SELECT cam.retail_price FROM campaign cam
        WHERE cam.product_id = c.product_id AND cam.retail_price > 0
        ORDER BY cam.id DESC LIMIT 1) AS campaignRetailPrice
     FROM cart c
     JOIN product p ON p.id = c.product_id AND p.active = 1
     WHERE c.customer_id = ?
     ORDER BY c.added_date DESC`,
    [customerId]
  );

  return rows.map(r => {
    const hasGroupDeal   = r.priceType === 'DEAL';
    const specs = parseSpecs(r.specs);
    // Seller-controlled payment availability for this product (defaults to allowed
    // when not explicitly set to false, matching the seller-side AddProduct default).
    const shipCod    = specs.ship_cod    !== false;
    const shipOnline = specs.ship_online !== false;
    // Resolve best available retail and deal prices:
    // locked_price in cart may be 0 if campaign prices weren't on product table at completion time.
    // Fall back to campaign.hold_price (most recent campaign with a price) or product.hold_price.
    const resolvedRetailPrice = Number(r.campaignRetailPrice) || Number(r.retailPrice);
    const resolvedHoldPrice   = Number(r.campaignHoldPrice)   || Number(r.holdPrice) || resolvedRetailPrice;
    const effectivePrice = hasGroupDeal
      ? (Number(r.lockedPrice) > 0 ? Number(r.lockedPrice) : resolvedHoldPrice)
      : resolvedRetailPrice;
    const discountPct    = hasGroupDeal && resolvedRetailPrice > 0
      ? Math.round((1 - effectivePrice / resolvedRetailPrice) * 100)
      : 0;

    return {
      cartId:        r.cartId,
      productId:     r.productId,
      priceType:     r.priceType,
      quantity:      r.quantity,
      name:          r.name,
      retailPrice:   resolvedRetailPrice,
      holdPrice:     resolvedHoldPrice,
      effectivePrice,
      discountPct,
      hasGroupDeal,
      // Calculate the correct deposit from resolved prices x quantity.
      // The stored deposit_paid may be wrong (set when prices were 0 or incorrect),
      // so always use the calculated value based on the current correct prices.
      depositPaid:   hasGroupDeal ? Math.max(0, resolvedRetailPrice - resolvedHoldPrice) * r.quantity : 0,
      imageUrl:      parseImages(r.image_url)[0] || null,
      stock:         r.stock,
      category:      r.category,
      subtotal:      effectivePrice * r.quantity,
      shipCod,
      shipOnline,
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
  // Ensure the customer_cancelled_deal tracking table exists
  await db.query(`
    CREATE TABLE IF NOT EXISTS customer_cancelled_deal (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      customer_id  INT NOT NULL,
      product_id   INT NOT NULL,
      campaign_id  INT,
      cancelled_at DATETIME NOT NULL DEFAULT NOW(),
      INDEX idx_ccd_customer (customer_id)
    )
  `);

  // Fetch the cart row first so we know the price_type and product
  const [rows] = await db.query(
    'SELECT price_type, product_id FROM cart WHERE id = ? AND customer_id = ?',
    [cartId, customerId]
  );

  // If it's a DEAL item, record the cancellation before deleting
  if (rows.length && rows[0].price_type === 'DEAL') {
    const { product_id } = rows[0];
    // Find the most recent campaign for this product to link it
    const [campRows] = await db.query(
      'SELECT id FROM campaign WHERE product_id = ? ORDER BY id DESC LIMIT 1',
      [product_id]
    );
    const campaignId = campRows.length ? campRows[0].id : null;
    await db.query(
      'INSERT INTO customer_cancelled_deal (customer_id, product_id, campaign_id) VALUES (?, ?, ?)',
      [customerId, product_id, campaignId]
    );
  }

  // Remove by cartId so only the specific row (REGULAR or DEAL) is deleted
  await db.query('DELETE FROM cart WHERE id = ? AND customer_id = ?', [cartId, customerId]);
  return { message: 'Removed from cart' };
};

export const clearCart = async (customerId) => {
  await db.query('DELETE FROM cart WHERE customer_id = ?', [customerId]);
  return { message: 'Cart cleared' };
};