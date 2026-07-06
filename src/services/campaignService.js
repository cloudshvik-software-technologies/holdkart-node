import db from '../config/db.js';
import { sendDealJoinedEmail, sendDealTargetReachedEmail } from '../config/email.js';
import * as txSvc from './transactionService.js';

// ── One-time migration ──────────────────────────────────────────────────────
// `campaign_hold` previously had no way to record which variant (colour /
// size) a customer picked when joining a group deal — every hold row was
// keyed only by (campaign_id, customer_id, product_id), so when the deal
// completed and slots were moved into the cart, the variant the customer
// actually selected was lost and the cart fell back to the product's
// default variant/image/price. This adds a variant_id column (0 = no
// variant, same convention the `cart` table already uses) so each hold
// remembers its variant and the completed deal can be added to the cart
// with the correct colour/size/price. Runs lazily on first use.
let variantColumnReady = null;
const ensureVariantColumn = async () => {
  if (variantColumnReady) return variantColumnReady;
  variantColumnReady = (async () => {
    try {
      const [cols] = await db.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'campaign_hold' AND column_name = 'variant_id'`
      );
      if (!cols.length) {
        await db.query(`ALTER TABLE campaign_hold ADD COLUMN variant_id INT NOT NULL DEFAULT 0`);
      }
    } catch (e) {
      console.error('campaign_hold variant_id migration check failed:', e.message);
    }
  })();
  return variantColumnReady;
};

export const listCampaigns = async () => {
  const [rows] = await db.query(
    `SELECT c.*, p.product_name, p.image_url, p.description, p.category,
            COALESCE(NULLIF(c.retail_price, 0), p.retail_price) AS retail_price,
            COALESCE(NULLIF(c.hold_price, 0), p.hold_price)     AS hold_price,
            s.business_name AS "sellerName",
            ROUND((c.current_hold / c.target) * 100) AS "progressPct"
     FROM campaign c
     JOIN product p ON p.id = c.product_id AND p.active = true
     JOIN seller s ON s.id = c.seller_id
     WHERE c.status = 'ACTIVE' AND (c.end_time IS NULL OR c.end_time > NOW())
     ORDER BY c.start_time DESC`
  );
  return rows;
};

export const joinCampaign = async ({ customerId, campaignId, quantity = 1 }) => {
  quantity = Math.max(1, parseInt(quantity, 10) || 1);

  const [rows] = await db.query(
    `SELECT c.* FROM campaign c
     JOIN product p ON p.id = c.product_id AND p.active = true
     WHERE c.id = ? AND c.status = 'ACTIVE'`,
    [campaignId]
  );
  if (!rows.length) { const e = new Error('Campaign not found or inactive'); e.status = 404; throw e; }
  const c = rows[0];

  const [existing] = await db.query(
    'SELECT id FROM campaign_hold WHERE campaign_id = ? AND customer_id = ?',
    [campaignId, customerId]
  );
  if (existing.length) { const e = new Error('You have already joined this campaign'); e.status = 409; throw e; }

  for (let i = 0; i < quantity; i++) {
    await db.query(
      'INSERT INTO campaign_hold (campaign_id, customer_id, product_id) VALUES (?,?,?)',
      [campaignId, customerId, c.product_id]
    );
  }

  await db.query(
    'UPDATE campaign SET current_hold = LEAST(current_hold + ?, target) WHERE id = ?',
    [quantity, campaignId]
  );

  const [updated] = await db.query('SELECT * FROM campaign WHERE id = ?', [campaignId]);
  if (updated[0] && updated[0].current_hold >= updated[0].target) {
    await _completeCampaignAndReset(updated[0]);
  }

  return { message: 'You have joined the hold campaign!' };
};

export const leaveCampaign = async ({ customerId, campaignId }) => {
  const [rows] = await db.query("SELECT * FROM campaign WHERE id = ? AND status IN ('ACTIVE', 'PAUSED')", [campaignId]);
  if (!rows.length) { const e = new Error('Cannot leave a completed or inactive campaign'); e.status = 400; throw e; }

  const [existing] = await db.query(
    'SELECT id FROM campaign_hold WHERE campaign_id = ? AND customer_id = ?',
    [campaignId, customerId]
  );
  if (!existing.length) { const e = new Error('You have not joined this campaign'); e.status = 404; throw e; }

  // Count how many slots this customer holds so we decrement accurately
  const [countRows] = await db.query(
    'SELECT COUNT(*) AS cnt FROM campaign_hold WHERE campaign_id = ? AND customer_id = ?',
    [campaignId, customerId]
  );
  const slotCount = countRows[0]?.cnt || 1;

  await db.query(
    'DELETE FROM campaign_hold WHERE campaign_id = ? AND customer_id = ?',
    [campaignId, customerId]
  );

  await db.query(
    'UPDATE campaign SET current_hold = GREATEST(0, current_hold - ?) WHERE id = ?',
    [slotCount, campaignId]
  );

  return { message: 'You have left the campaign' };
};

/**
 * getMyCampaigns — returns ACTIVE, PAUSED, and CANCELLED campaigns the customer has joined.
 * PAUSED campaigns are included so customers who already joined can still view their product.
 * CANCELLED campaigns include: seller-cancelled deals (via campaign_hold) AND
 *   deals the customer manually removed from cart (via customer_cancelled_deal table).
 */
export const getMyCampaigns = async (customerId) => {
  await _cancelCampaignsForDeletedProducts(customerId);

  // Ensure the customer_cancelled_deal tracking table exists
  await db.query(`
    CREATE TABLE IF NOT EXISTS customer_cancelled_deal (
      id           SERIAL PRIMARY KEY,
      customer_id  INT NOT NULL,
      product_id   INT NOT NULL,
      campaign_id  INT,
      cancelled_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ccd_customer ON customer_cancelled_deal (customer_id)`);

  // Part 1: ACTIVE and PAUSED deals (customer still has campaign_hold rows)
  const [activeRows] = await db.query(
    `SELECT MIN(ch.id) AS "holdId", ch.campaign_id, c.id AS "campaignRowId", ch.customer_id,
            ch.product_id, MIN(ch.joined_date) AS joined_date,
            c.status AS "campaignStatus", c.target, c.current_hold,
            c.variant_id AS "variantId", c.variant_label AS "variantLabel",
            COUNT(ch.id) AS "mySlots",
            p.product_name, p.image_url, p.category,
            COALESCE(NULLIF(c.retail_price, 0), p.retail_price) AS retail_price,
            COALESCE(NULLIF(c.hold_price, 0), p.hold_price)     AS hold_price,
            pv.color AS "variantColor", pv.size AS "variantSize",
            (SELECT vi.image_url FROM product_variant_image vi
             WHERE vi.variant_id = pv.id ORDER BY vi.sort_order, vi.id LIMIT 1) AS "variantImage"
     FROM campaign_hold ch
     JOIN campaign c ON c.id = ch.campaign_id
     LEFT JOIN product p ON p.id = ch.product_id
     LEFT JOIN product_variant pv ON pv.id = c.variant_id
     WHERE ch.customer_id = ? AND c.status IN ('ACTIVE', 'PAUSED')
     GROUP BY ch.campaign_id, c.id, ch.customer_id, ch.product_id,
              c.status, c.target, c.current_hold, c.variant_id, c.variant_label,
              p.product_name, p.image_url, p.category,
              c.retail_price, c.hold_price, p.retail_price, p.hold_price,
              pv.color, pv.size, pv.id`,
    [customerId]
  );

  // Part 2: Seller-cancelled deals (campaign status = CANCELLED, hold rows may still exist)
  const [sellerCancelledRows] = await db.query(
    `SELECT MIN(ch.id) AS "holdId", ch.campaign_id, c.id AS "campaignRowId", ch.customer_id,
            ch.product_id, MIN(ch.joined_date) AS joined_date,
            'CANCELLED' AS "campaignStatus", c.target, c.current_hold,
            c.variant_id AS "variantId", c.variant_label AS "variantLabel",
            COUNT(ch.id) AS "mySlots",
            p.product_name, p.image_url, p.category,
            COALESCE(NULLIF(c.retail_price, 0), p.retail_price) AS retail_price,
            COALESCE(NULLIF(c.hold_price, 0), p.hold_price)     AS hold_price,
            pv.color AS "variantColor", pv.size AS "variantSize",
            (SELECT vi.image_url FROM product_variant_image vi
             WHERE vi.variant_id = pv.id ORDER BY vi.sort_order, vi.id LIMIT 1) AS "variantImage"
     FROM campaign_hold ch
     JOIN campaign c ON c.id = ch.campaign_id
     LEFT JOIN product p ON p.id = ch.product_id
     LEFT JOIN product_variant pv ON pv.id = c.variant_id
     WHERE ch.customer_id = ? AND c.status = 'CANCELLED'
     GROUP BY ch.campaign_id, c.id, ch.customer_id, ch.product_id,
              c.target, c.current_hold, c.variant_id, c.variant_label,
              p.product_name, p.image_url, p.category,
              c.retail_price, c.hold_price, p.retail_price, p.hold_price,
              pv.color, pv.size, pv.id`,
    [customerId]
  );

  // Part 3: Customer-cancelled deals (removed DEAL item from cart after deal completed)
  const [customerCancelledRows] = await db.query(
    `SELECT ccd.id AS "holdId", ccd.campaign_id, ccd.campaign_id AS "campaignRowId", ccd.customer_id,
            ccd.product_id, ccd.cancelled_at AS joined_date,
            'CANCELLED' AS "campaignStatus",
            COALESCE(c.target, 0) AS target, COALESCE(c.current_hold, 0) AS current_hold,
            c.variant_id AS "variantId", c.variant_label AS "variantLabel",
            1 AS "mySlots",
            p.product_name, p.image_url, p.category,
            COALESCE(NULLIF(c.retail_price, 0), p.retail_price) AS retail_price,
            COALESCE(NULLIF(c.hold_price, 0), p.hold_price)     AS hold_price,
            pv.color AS "variantColor", pv.size AS "variantSize",
            (SELECT vi.image_url FROM product_variant_image vi
             WHERE vi.variant_id = pv.id ORDER BY vi.sort_order, vi.id LIMIT 1) AS "variantImage"
     FROM customer_cancelled_deal ccd
     LEFT JOIN campaign c ON c.id = ccd.campaign_id
     LEFT JOIN product p ON p.id = ccd.product_id
     LEFT JOIN product_variant pv ON pv.id = c.variant_id
     WHERE ccd.customer_id = ?`,
    [customerId]
  );

  // Merge all, deduplicate by product_id (prefer active/paused over cancelled)
  const seen = new Set();
  const result = [];
  for (const row of [...activeRows, ...sellerCancelledRows, ...customerCancelledRows]) {
    const key = String(row.product_id);
    if (!seen.has(key)) {
      seen.add(key);
      // Show the exact variant (colour/size + its own photo) this customer
      // joined with, instead of always falling back to the base product's
      // default image/name — a product can run several deals at once, each
      // for a different colour/size.
      result.push({
        ...row,
        variant_label: row.variantLabel || null,
        variant_color: row.variantColor || null,
        variant_size:  row.variantSize  || null,
        image_url:     row.variantImage || row.image_url,
      });
    }
  }

  return result.sort((a, b) => new Date(b.joined_date) - new Date(a.joined_date));
};

/**
 * getProductCampaignStatus — returns the campaign status for a given product.
 * Used by the frontend to decide if a product is paused (existing holders can view
 * but cannot buy; it shows as out of stock to them).
 */
export const getProductCampaignStatus = async (productId) => {
  const [rows] = await db.query(
    `SELECT status FROM campaign
     WHERE product_id = ? AND status IN ('ACTIVE', 'PAUSED')
     ORDER BY CASE status WHEN 'ACTIVE' THEN 0 WHEN 'PAUSED' THEN 1 ELSE 2 END ASC
     LIMIT 1`,
    [productId]
  );
  return rows[0]?.status || null;
};

export const getCampaignById = async (campaignId) => {
  const [rows] = await db.query(
    `SELECT c.*, p.product_name, p.image_url, p.description,
            COALESCE(NULLIF(c.retail_price, 0), p.retail_price) AS retail_price,
            COALESCE(NULLIF(c.hold_price, 0), p.hold_price)     AS hold_price,
            s.business_name AS "sellerName",
            ROUND((c.current_hold / c.target) * 100) AS "progressPct",
            pv.color AS variant_color, pv.size AS variant_size,
            (SELECT vi.image_url FROM product_variant_image vi
             WHERE vi.variant_id = pv.id ORDER BY vi.sort_order, vi.id LIMIT 1) AS variant_image
     FROM campaign c
     JOIN product p ON p.id = c.product_id AND p.active = true
     JOIN seller s  ON s.id = c.seller_id
     LEFT JOIN product_variant pv ON pv.id = c.variant_id
     WHERE c.id = ?`,
    [campaignId]
  );
  if (!rows.length) { const e = new Error('Campaign not found or product is no longer available'); e.status = 404; throw e; }
  const row = rows[0];
  // A product can run several deals at once, each scoped to a different
  // colour/size — show the exact variant this campaign is for, and its own
  // photo, instead of always falling back to the base product's default.
  return {
    ...row,
    image_url: row.variant_image || row.image_url,
  };
};

export const startOrJoinCampaign = async ({ customerId, productId, variantId = null, quantity = 1, cashfreeOrderId = null, depositAmount = null }) => {
  quantity = Math.max(1, parseInt(quantity, 10) || 1);
  variantId = parseInt(variantId, 10) || 0;
  await ensureVariantColumn();

  const [products] = await db.query(
    'SELECT id, seller_id, hold_target FROM product WHERE id = ? AND active = true',
    [productId]
  );
  if (!products.length) { const e = new Error('Product not found or no longer available'); e.status = 404; throw e; }
  const product = products[0];

  // Check for an existing active campaign first (seller may have set target via campaign portal).
  // A product can have several campaigns running at once, each scoped to a specific
  // colour/size (e.g. "Blue / M" and "Red / L" are independent deals). Fetch all active
  // campaigns for the product and prefer the one that exactly matches the variant the
  // customer selected, falling back to a whole-product (variant_id IS NULL/0) campaign.
  // Picking blindly via LIMIT 1 (the previous behaviour) could attach the join to the
  // wrong variant's campaign whenever more than one was active — this also caused a
  // rejoin after a completed round to misbehave once that round auto-restarted.
  let [activeCampaigns] = await db.query(
    "SELECT * FROM campaign WHERE product_id = ? AND status = 'ACTIVE' AND (end_time IS NULL OR end_time > NOW())",
    [productId]
  );

  let campaign = activeCampaigns.find(c => variantId && Number(c.variant_id) === Number(variantId))
    || activeCampaigns.find(c => !c.variant_id);

  // Product supports group deals if it has hold_target set OR already has an active campaign
  const effectiveTarget = (campaign && campaign.target > 0) ? campaign.target : product.hold_target;
  if (!effectiveTarget || effectiveTarget <= 0) {
    const e = new Error('This product does not support group deals');
    e.status = 400;
    throw e;
  }

  if (!campaign) {
    const [result] = await db.query(
      `INSERT INTO campaign (product_id, seller_id, target, current_hold, status, start_time)
       VALUES (?, ?, ?, 0, 'ACTIVE', NOW())`,
      [productId, product.seller_id, effectiveTarget]
    );
    const [newCampaign] = await db.query('SELECT * FROM campaign WHERE id = ?', [result.insertId]);
    campaign = newCampaign[0];
  }

  // Scope the "already joined" check to this variant — a whole-product campaign can be
  // shared by several colour/size combinations, so a hold on a different variant should
  // not block joining this one.
  const [existing] = await db.query(
    'SELECT id FROM campaign_hold WHERE campaign_id = ? AND customer_id = ? AND variant_id = ?',
    [campaign.id, customerId, variantId]
  );
  if (existing.length) {
    const e = new Error('You have already joined this campaign');
    e.status = 409;
    throw e;
  }

  // Insert one row per unit so each slot is tracked individually
  for (let i = 0; i < quantity; i++) {
    await db.query(
      'INSERT INTO campaign_hold (campaign_id, customer_id, product_id, variant_id) VALUES (?,?,?,?)',
      [campaign.id, customerId, productId, variantId]
    );
  }

  await db.query(
    'UPDATE campaign SET current_hold = LEAST(current_hold + ?, target) WHERE id = ?',
    [quantity, campaign.id]
  );

  const [updated] = await db.query('SELECT * FROM campaign WHERE id = ?', [campaign.id]);
  if (updated[0] && updated[0].current_hold >= updated[0].target) {
    await _completeCampaignAndReset(updated[0]);
  }

  // Record deposit transaction using actual payment info from frontend
  try {
    const [priceRows] = await db.query(
      'SELECT retail_price, hold_price, product_name FROM product WHERE id = ?',
      [productId]
    );
    if (priceRows.length) {
      const retailPrice    = Number(priceRows[0].retail_price);
      const holdPrice      = Number(priceRows[0].hold_price);
      const productName    = priceRows[0].product_name;
      const depositPerUnit = Math.max(0, retailPrice - holdPrice);
      // Use actual amount paid from frontend; fall back to calculated deposit
      const totalDeposit   = depositAmount || (depositPerUnit * quantity);
      if (totalDeposit > 0) {
        await txSvc.record({
          customerId,
          orderId:         null,
          orderNumber:     null,
          amount:          totalDeposit,
          type:            'DEAL_DEPOSIT',
          method:          'Online',
          status:          'SUCCESS',
          description:     `Deal deposit for "${productName}" x${quantity} (Campaign #${campaign.id})`,
          cashfreeOrderId: cashfreeOrderId,
        });
      }
    }
  } catch (txErr) {
    console.error('[campaignService] transaction record error:', txErr.message);
  }

  // Send deal joined email
  try {
    const [crows] = await db.query('SELECT name, email FROM customer WHERE id = ?', [customerId]);
    if (crows.length && crows[0].email) {
      const [prRows] = await db.query('SELECT product_name, hold_price, retail_price FROM product WHERE id = ?', [productId]);
      await sendDealJoinedEmail(crows[0].email, {
        name:          crows[0].name,
        productName:   prRows[0]?.product_name || 'Product',
        quantity,
        depositAmount,
        campaignId:    campaign.id,
        holdPrice:     prRows[0]?.hold_price   || null,
        retailPrice:   prRows[0]?.retail_price || null,
      });
    }
  } catch (emailErr) {
    console.error('[campaignService] join deal email error:', emailErr.message);
  }

  return { message: 'You have joined the group deal!', campaignId: campaign.id };
};

/**
 * addToDeal — called when an already-joined customer adds more units.
 */
export const addToDeal = async ({ customerId, productId, variantId = null, quantity = 1, cashfreeOrderId = null, depositAmount = null }) => {
  quantity = Math.max(1, parseInt(quantity, 10) || 1);
  variantId = parseInt(variantId, 10) || 0;
  await ensureVariantColumn();

  // Same variant-aware lookup as startOrJoinCampaign — don't blindly grab any active
  // campaign for the product when several variant-scoped campaigns can be running at once.
  const [activeCampaigns] = await db.query(
    "SELECT * FROM campaign WHERE product_id = ? AND status = 'ACTIVE' AND (end_time IS NULL OR end_time > NOW())",
    [productId]
  );
  const campaign = activeCampaigns.find(c => variantId && Number(c.variant_id) === Number(variantId))
    || activeCampaigns.find(c => !c.variant_id);
  if (!campaign) {
    const e = new Error('No active campaign found for this product');
    e.status = 404;
    throw e;
  }

  // Insert one row per unit
  for (let i = 0; i < quantity; i++) {
    await db.query(
      'INSERT INTO campaign_hold (campaign_id, customer_id, product_id, variant_id) VALUES (?,?,?,?)',
      [campaign.id, customerId, productId, variantId]
    );
  }

  await db.query(
    'UPDATE campaign SET current_hold = LEAST(current_hold + ?, target) WHERE id = ?',
    [quantity, campaign.id]
  );

  const [updated] = await db.query('SELECT * FROM campaign WHERE id = ?', [campaign.id]);
  const dealCompleted = !!(updated[0] && updated[0].current_hold >= updated[0].target);
  if (dealCompleted) {
    await _completeCampaignAndReset(updated[0]);
  }

  // Record deposit transaction for the added slots
  try {
    const [priceRows] = await db.query(
      'SELECT retail_price, hold_price, product_name FROM product WHERE id = ?',
      [productId]
    );
    if (priceRows.length) {
      const retailPrice    = Number(priceRows[0].retail_price);
      const holdPrice      = Number(priceRows[0].hold_price);
      const productName    = priceRows[0].product_name;
      const depositPerUnit = Math.max(0, retailPrice - holdPrice);
      const totalDeposit   = depositAmount || (depositPerUnit * quantity);
      if (totalDeposit > 0) {
        await txSvc.record({
          customerId,
          orderId:         null,
          orderNumber:     null,
          amount:          totalDeposit,
          type:            'DEAL_DEPOSIT',
          method:          'Online',
          status:          'SUCCESS',
          description:     `Deal deposit for "${productName}" x${quantity} (Campaign #${campaign.id})`,
          cashfreeOrderId: cashfreeOrderId,
        });
      }
    }
  } catch (txErr) {
    console.error('[campaignService] addToDeal transaction error:', txErr.message);
  }

  return { message: 'Slot added to deal!', campaignId: campaign.id, dealCompleted };
};

/**
 * cancelCampaignsForProduct — called when a seller deletes/deactivates a product.
 */
export const cancelCampaignsForProduct = async (productId) => {
  const [activeCampaigns] = await db.query(
    "SELECT * FROM campaign WHERE product_id = ? AND status = 'ACTIVE'",
    [productId]
  );

  for (const campaign of activeCampaigns) {
    await db.query("UPDATE campaign SET status = 'CANCELLED' WHERE id = ?", [campaign.id]);

    const [holders] = await db.query(
      'SELECT customer_id, product_id FROM campaign_hold WHERE campaign_id = ?',
      [campaign.id]
    );

    const [prows] = await db.query('SELECT product_name FROM product WHERE id = ?', [productId]);
    const productName = prows[0]?.product_name || 'a product';

    // Deduplicate — notify each unique customer once
    const seen = new Set();
    for (const h of holders) {
      if (seen.has(h.customer_id)) continue;
      seen.add(h.customer_id);

      await db.query(
        'DELETE FROM cart WHERE customer_id = ? AND product_id = ?',
        [h.customer_id, h.product_id]
      );

      await db.query(
        `INSERT INTO customer_notification (customer_id, title, message, type)
         VALUES (?, ?, ?, ?)`,
        [
          h.customer_id,
          '⚠️ Group Deal Cancelled',
          `The group deal for "${productName}" has been cancelled because the seller removed the product. We're sorry for the inconvenience.`,
          'CAMPAIGN',
        ]
      );
    }

    await db.query('DELETE FROM campaign_hold WHERE campaign_id = ?', [campaign.id]);
  }
};

async function _cancelCampaignsForDeletedProducts(customerId) {
  const [staleHolds] = await db.query(
    `SELECT ch.campaign_id, ch.product_id
     FROM campaign_hold ch
     JOIN campaign c ON c.id = ch.campaign_id AND c.status = 'ACTIVE'
     JOIN product p ON p.id = ch.product_id AND p.active = false
     WHERE ch.customer_id = ?`,
    [customerId]
  );

  for (const hold of staleHolds) {
    await cancelCampaignsForProduct(hold.product_id);
  }
}

/**
 * _completeCampaignAndReset — fires when current_hold >= target.
 * Groups rows by customer so each customer gets the correct quantity in cart.
 */
async function _completeCampaignAndReset(campaign) {
  await db.query("UPDATE campaign SET status = 'COMPLETED' WHERE id = ?", [campaign.id]);

  // Group by customer AND variant so each customer's chosen colour/size
  // keeps its own cart row instead of collapsing into the product's
  // default variant.
  const [holderGroups] = await db.query(
    `SELECT customer_id, product_id, variant_id, COUNT(*) AS slot_count
     FROM campaign_hold
     WHERE campaign_id = ?
     GROUP BY customer_id, product_id, variant_id`,
    [campaign.id]
  );

  const [priceRows] = await db.query('SELECT retail_price, hold_price, product_name FROM product WHERE id = ?', [campaign.product_id]);
  const productName   = priceRows[0]?.product_name || 'the product';
  // Prefer campaign-level prices (set via seller portal) over product-level prices
  const lockedPrice = (Number(campaign.hold_price) > 0 ? Number(campaign.hold_price) : null) ?? (Number(priceRows[0]?.hold_price) || null);
  const retailPrice = (Number(campaign.retail_price) > 0 ? Number(campaign.retail_price) : null) ?? (Number(priceRows[0]?.retail_price) || null);
  // depositPerUnit = what each customer paid upfront when joining = retailPrice - holdPrice
  const depositPerUnit = (retailPrice !== null && lockedPrice !== null)
    ? Math.max(0, Number(retailPrice) - Number(lockedPrice))
    : 0;

  for (const h of holderGroups) {
    const slotCount   = h.slot_count;
    // Total deposit this customer actually paid for this batch of slots
    const depositPaid = depositPerUnit * slotCount;

    const [existingDealRow] = await db.query(
      "SELECT id, quantity, deposit_paid FROM cart WHERE customer_id = ? AND product_id = ? AND variant_id = ? AND price_type = 'DEAL'",
      [h.customer_id, h.product_id, h.variant_id]
    );

    let notificationMessage;
    if (existingDealRow.length === 0) {
      // First time this exact customer+variant deal completes — insert with correct quantity and deposit
      await db.query(
        `INSERT INTO cart (customer_id, product_id, variant_id, quantity, price_type, locked_price, deposit_paid)
         VALUES (?, ?, ?, ?, 'DEAL', ?, ?)`,
        [h.customer_id, h.product_id, h.variant_id, slotCount, lockedPrice, depositPaid]
      );
      notificationMessage = `The group deal for "${productName}" has been fulfilled! ${slotCount} unit${slotCount > 1 ? 's have' : ' has'} been added to your cart at the group deal price.`;
    } else {
      // Add to existing DEAL row for this variant — accumulate the new batch's deposit on top
      const prevDeposit = Number(existingDealRow[0].deposit_paid) || 0;
      await db.query(
        "UPDATE cart SET quantity = quantity + ?, deposit_paid = ? WHERE customer_id = ? AND product_id = ? AND variant_id = ? AND price_type = 'DEAL'",
        [slotCount, prevDeposit + depositPaid, h.customer_id, h.product_id, h.variant_id]
      );
      notificationMessage = `The group deal for "${productName}" has been fulfilled again! ${slotCount} more unit${slotCount > 1 ? 's have' : ' has'} been added to your cart at the deal price.`;
    }

    await db.query(
      `INSERT INTO customer_notification (customer_id, title, message, type)
       VALUES (?, ?, ?, ?)`,
      [
        h.customer_id,
        '🎉 Group Deal Complete!',
        notificationMessage,
        'CAMPAIGN',
      ]
    );

    // Send deal target reached email
    try {
      const [crows] = await db.query('SELECT email FROM customer WHERE id = ?', [h.customer_id]);
      if (crows.length && crows[0].email) {
        const [cnameRows] = await db.query('SELECT name FROM customer WHERE id = ?', [h.customer_id]);
        await sendDealTargetReachedEmail(crows[0].email, {
          name:        cnameRows[0]?.name || 'Customer',
          productName,
          holdPrice:   lockedPrice,
          quantity:    slotCount,
        });
      }
    } catch (emailErr) {
      console.error('[campaignService] deal target email error:', emailErr.message);
    }
  }

  await db.query('DELETE FROM campaign_hold WHERE campaign_id = ?', [campaign.id]);

  const [stockRows] = await db.query(
    'SELECT stock_quantity, hold_target, seller_id FROM product WHERE id = ? AND active = true',
    [campaign.product_id]
  );

  // If the completed campaign was scoped to a specific variant (e.g. "Blue / M"),
  // check that variant's own stock (not the whole product's) before restarting a
  // new round, and carry the variant forward — otherwise the new round silently
  // turns into a whole-product campaign and stops being tied to the colour/size
  // the customer actually joined for.
  let variantStockOk = true;
  if (campaign.variant_id) {
    const [variantStockRows] = await db.query(
      'SELECT stock_quantity FROM product_variant WHERE id = ? AND product_id = ?',
      [campaign.variant_id, campaign.product_id]
    );
    variantStockOk = variantStockRows.length && variantStockRows[0].stock_quantity > 0;
  }

  if (stockRows.length && stockRows[0].stock_quantity > 0 && variantStockOk) {
    // Use campaign's own target/prices (set via seller portal); fall back to product table
    const newTarget      = (campaign.target > 0 ? campaign.target : stockRows[0].hold_target) || 0;
    const newHoldPrice   = campaign.hold_price   || null;
    const newRetailPrice = campaign.retail_price || null;
    if (newTarget > 0) {
      await db.query(
        `INSERT INTO campaign (product_id, seller_id, target, current_hold, status, start_time, hold_price, retail_price, variant_id, variant_label)
         VALUES (?, ?, ?, 0, 'ACTIVE', NOW(), ?, ?, ?, ?)`,
        [campaign.product_id, stockRows[0].seller_id, newTarget, newHoldPrice, newRetailPrice, campaign.variant_id || null, campaign.variant_label || null]
      );
    }
  }
}