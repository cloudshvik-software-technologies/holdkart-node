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

// ── One-time migration ──────────────────────────────────────────────────────
// The `cart` table previously had no way to record which variant (colour /
// size) a customer chose — every row was keyed only by (customer_id,
// product_id, price_type), so adding "Red / M" and "Blue / L" of the same
// product collapsed into a single row and silently kept whichever variant
// got there first. This adds a variant_id column (0 = no variant selected,
// same as the product's base listing) and widens the uniqueness key to
// include it, so each distinct product+variant combination gets its own
// cart row. Runs lazily on first use; checks INFORMATION_SCHEMA first so
// it's a no-op once already applied.
let variantColumnReady = null;
const ensureVariantColumn = async () => {
  if (variantColumnReady) return variantColumnReady;
  variantColumnReady = (async () => {
    try {
      const [cols] = await db.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cart' AND COLUMN_NAME = 'variant_id'`
      );
      if (!cols.length) {
        await db.query(`ALTER TABLE cart ADD COLUMN variant_id INT NOT NULL DEFAULT 0 AFTER product_id`);
      }

      // Find any unique key covering (customer_id, product_id, price_type)
      // that does NOT already include variant_id, and widen it — otherwise
      // inserting a second variant for the same product still collides
      // against the old constraint.
      const [rows] = await db.query(
        `SELECT INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols
         FROM INFORMATION_SCHEMA.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cart'
           AND NON_UNIQUE = 0 AND INDEX_NAME != 'PRIMARY'
         GROUP BY INDEX_NAME`
      );
      const staleKey = rows.find(r => {
        const c = (r.cols || '').split(',');
        return c.includes('customer_id') && c.includes('product_id') && c.includes('price_type') && !c.includes('variant_id');
      });
      if (staleKey) {
        await db.query(`ALTER TABLE cart DROP INDEX \`${staleKey.INDEX_NAME}\``);
        await db.query(`ALTER TABLE cart ADD UNIQUE KEY uniq_cart_item (customer_id, product_id, variant_id, price_type)`);
      }
    } catch (e) {
      // Non-fatal — if this partially applied before, later calls just find
      // things already in place. Cart still works even if this fails, it
      // just won't yet distinguish variants.
      console.error('Cart variant_id migration check failed:', e.message);
    }
  })();
  return variantColumnReady;
};

export const addToCart = async ({ customerId, productId, variantId, quantity = 1 }) => {
  await ensureVariantColumn();
  const vId = variantId ? Number(variantId) : 0;

  let remainingStock;

  if (vId > 0) {
    // A variant was selected — its own stock (minus what's reserved) governs
    // availability, not the base product's stock_quantity.
    const [variantRows] = await db.query(
      `SELECT stock_quantity, reserved_stock FROM product_variant
       WHERE id = ? AND product_id = ? AND active = 1 LIMIT 1`,
      [vId, productId]
    );
    if (!variantRows.length) {
      const e = new Error('Selected variant is not available');
      e.status = 400;
      throw e;
    }
    const { stock_quantity, reserved_stock } = variantRows[0];
    remainingStock = Math.max(0, (stock_quantity || 0) - (reserved_stock || 0));
  } else {
    // If an ACTIVE campaign exists for this product, the available quantity is
    // total stock minus the slots already committed in that campaign.
    // If there is NO active campaign, the product is a fixed-price item and is
    // purchasable directly using the product's own stock_quantity.
    const [campaignRows] = await db.query(
      `SELECT c.id, c.current_hold, p.stock_quantity
       FROM campaign c
       JOIN product p ON p.id = c.product_id
       WHERE c.product_id = ? AND c.status = 'ACTIVE'
         AND (c.end_time IS NULL OR c.end_time > NOW())
       LIMIT 1`,
      [productId]
    );

    if (campaignRows.length) {
      const { current_hold, stock_quantity } = campaignRows[0];
      remainingStock = Math.max(0, stock_quantity - current_hold);
    } else {
      const [productRows] = await db.query(
        `SELECT stock_quantity FROM product WHERE id = ? AND active = 1 LIMIT 1`,
        [productId]
      );

      if (!productRows.length) {
        const e = new Error('This product is not available for purchase right now');
        e.status = 400;
        throw e;
      }

      remainingStock = Math.max(0, productRows[0].stock_quantity);
    }
  }

  if (remainingStock <= 0) {
    const e = new Error('No stock available — all units are reserved for the active campaign');
    e.status = 400;
    throw e;
  }

  // Cap the requested quantity to the remaining available stock
  const allowedQty = Math.min(quantity, remainingStock);

  // Manual "Add to Cart" always goes in as a REGULAR price row, one row per
  // distinct (product, variant) combination so different variants never merge.
  const [existing] = await db.query(
    `SELECT id FROM cart WHERE customer_id = ? AND product_id = ? AND variant_id = ? AND price_type = 'REGULAR' LIMIT 1`,
    [customerId, productId, vId]
  );
  if (existing.length) {
    await db.query(`UPDATE cart SET quantity = quantity + ? WHERE id = ?`, [allowedQty, existing[0].id]);
  } else {
    await db.query(
      `INSERT INTO cart (customer_id, product_id, variant_id, quantity, price_type, locked_price)
       VALUES (?, ?, ?, ?, 'REGULAR', NULL)`,
      [customerId, productId, vId, allowedQty]
    );
  }
  return { message: 'Added to cart' };
};

export const getCart = async (customerId) => {
  await ensureVariantColumn();
  const [rows] = await db.query(
    `SELECT
       c.id             AS cartId,
       c.quantity,
       c.product_id     AS productId,
       c.variant_id     AS variantId,
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
       pv.color           AS variantColor,
       pv.size            AS variantSize,
       pv.price_override  AS variantPrice,
       pv.stock_quantity  AS variantStock,
       pv.reserved_stock  AS variantReserved,
       (SELECT vi.image_url FROM product_variant_image vi
        WHERE vi.variant_id = pv.id ORDER BY vi.sort_order, vi.id LIMIT 1) AS variantImage,
       (SELECT cam.hold_price FROM campaign cam
        WHERE cam.product_id = c.product_id AND cam.hold_price > 0
        ORDER BY cam.id DESC LIMIT 1) AS campaignHoldPrice,
       (SELECT cam.retail_price FROM campaign cam
        WHERE cam.product_id = c.product_id AND cam.retail_price > 0
        ORDER BY cam.id DESC LIMIT 1) AS campaignRetailPrice
     FROM cart c
     JOIN product p ON p.id = c.product_id AND p.active = 1
     LEFT JOIN product_variant pv ON pv.id = c.variant_id AND pv.product_id = c.product_id
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
    // A selected variant's own price always wins — campaignRetailPrice is a flat,
    // variant-agnostic snapshot and must not override what a specific colour/size
    // actually costs (e.g. Red ₹1,200 vs Blue ₹900 of the same product).
    const baseRetailPrice     = r.variantPrice != null ? Number(r.variantPrice) : (Number(r.campaignRetailPrice) || Number(r.retailPrice));
    const resolvedRetailPrice = baseRetailPrice;
    const resolvedHoldPrice   = Number(r.campaignHoldPrice)   || Number(r.holdPrice) || resolvedRetailPrice;
    const effectivePrice = hasGroupDeal
      ? (Number(r.lockedPrice) > 0 ? Number(r.lockedPrice) : resolvedHoldPrice)
      : resolvedRetailPrice;
    const discountPct    = hasGroupDeal && resolvedRetailPrice > 0
      ? Math.round((1 - effectivePrice / resolvedRetailPrice) * 100)
      : 0;
    const variantStockAvailable = r.variantStock != null
      ? Math.max(0, Number(r.variantStock) - (Number(r.variantReserved) || 0))
      : null;

    return {
      cartId:        r.cartId,
      productId:     r.productId,
      variantId:     r.variantId > 0 ? r.variantId : null,
      color:         r.variantColor || null,
      size:          r.variantSize  || null,
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
      // A variant's own photo takes over from the base product's, same as
      // the product detail page's gallery behaviour.
      imageUrl:      r.variantImage || parseImages(r.image_url)[0] || null,
      stock:         variantStockAvailable != null ? variantStockAvailable : r.stock,
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

/**
 * mergeCart — called right after login to merge guest cart items into the
 * customer's server-side cart.
 *
 * Strategy: for each guest item, attempt addToCart (which respects stock /
 * campaign rules). Items that fail (no active campaign, out of stock, etc.)
 * are silently skipped so that valid items still get merged.
 *
 * @param {number} customerId
 * @param {Array<{ productId: number|string, variantId?: number|string, quantity: number }>} items
 * @returns {{ merged: number, skipped: number }}
 */
export const mergeCart = async (customerId, items = []) => {
  let merged = 0;
  let skipped = 0;

  for (const item of items) {
    try {
      await addToCart({
        customerId,
        productId: Number(item.productId),
        variantId: item.variantId ? Number(item.variantId) : undefined,
        quantity: Number(item.quantity) || 1,
      });
      merged++;
    } catch {
      // Product not available / out of stock — skip silently
      skipped++;
    }
  }

  return { merged, skipped };
};