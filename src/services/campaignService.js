import db from '../config/db.js';
import * as txSvc from './transactionService.js';

export const listCampaigns = async () => {
  const [rows] = await db.query(
    `SELECT c.*, p.product_name, p.image_url, p.retail_price, p.hold_price, p.description,
            s.business_name AS sellerName,
            ROUND((c.current_hold / c.target) * 100) AS progressPct
     FROM campaign c
     JOIN product p ON p.id = c.product_id AND p.active = 1
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
     JOIN product p ON p.id = c.product_id AND p.active = 1
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
 * getMyCampaigns — returns ACTIVE and PAUSED campaigns the customer has joined
 * where the product is still active (not deleted by seller).
 * PAUSED campaigns are included so customers who already joined can still view their product.
 */
export const getMyCampaigns = async (customerId) => {
  await _cancelCampaignsForDeletedProducts(customerId);

  const [rows] = await db.query(
    `SELECT MIN(ch.id) AS holdId, ch.campaign_id, c.id AS campaignRowId, ch.customer_id,
            ch.product_id, MIN(ch.joined_date) AS joined_date,
            c.status AS campaignStatus, c.target, c.current_hold,
            COUNT(ch.id) AS mySlots,
            p.product_name, p.image_url, p.retail_price, p.hold_price, p.category
     FROM campaign_hold ch
     JOIN campaign c ON c.id = ch.campaign_id
     JOIN product p ON p.id = ch.product_id AND p.active = 1
     WHERE ch.customer_id = ? AND c.status IN ('ACTIVE', 'PAUSED')
     GROUP BY ch.campaign_id, c.id, ch.customer_id, ch.product_id,
              c.status, c.target, c.current_hold,
              p.product_name, p.image_url, p.retail_price, p.hold_price, p.category
     ORDER BY joined_date DESC`,
    [customerId]
  );
  return rows;
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
     ORDER BY FIELD(status, 'ACTIVE', 'PAUSED') ASC
     LIMIT 1`,
    [productId]
  );
  return rows[0]?.status || null;
};

export const getCampaignById = async (campaignId) => {
  const [rows] = await db.query(
    `SELECT c.*, p.product_name, p.image_url, p.retail_price, p.hold_price, p.description,
            s.business_name AS sellerName,
            ROUND((c.current_hold / c.target) * 100) AS progressPct
     FROM campaign c
     JOIN product p ON p.id = c.product_id AND p.active = 1
     JOIN seller s  ON s.id = c.seller_id
     WHERE c.id = ?`,
    [campaignId]
  );
  if (!rows.length) { const e = new Error('Campaign not found or product is no longer available'); e.status = 404; throw e; }
  return rows[0];
};

export const startOrJoinCampaign = async ({ customerId, productId, quantity = 1, cashfreeOrderId = null, depositAmount = null }) => {
  quantity = Math.max(1, parseInt(quantity, 10) || 1);

  const [products] = await db.query(
    'SELECT id, seller_id, hold_target FROM product WHERE id = ? AND active = 1',
    [productId]
  );
  if (!products.length) { const e = new Error('Product not found or no longer available'); e.status = 404; throw e; }
  const product = products[0];

  // Check for an existing active campaign first (seller may have set target via campaign portal)
  let [campaigns] = await db.query(
    "SELECT * FROM campaign WHERE product_id = ? AND status = 'ACTIVE' AND (end_time IS NULL OR end_time > NOW()) LIMIT 1",
    [productId]
  );

  let campaign = campaigns[0];

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

  const [existing] = await db.query(
    'SELECT id FROM campaign_hold WHERE campaign_id = ? AND customer_id = ?',
    [campaign.id, customerId]
  );
  if (existing.length) {
    const e = new Error('You have already joined this campaign');
    e.status = 409;
    throw e;
  }

  // Insert one row per unit so each slot is tracked individually
  for (let i = 0; i < quantity; i++) {
    await db.query(
      'INSERT INTO campaign_hold (campaign_id, customer_id, product_id) VALUES (?,?,?)',
      [campaign.id, customerId, productId]
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

  return { message: 'You have joined the group deal!', campaignId: campaign.id };
};

/**
 * addToDeal — called when an already-joined customer adds more units.
 */
export const addToDeal = async ({ customerId, productId, quantity = 1, cashfreeOrderId = null, depositAmount = null }) => {
  quantity = Math.max(1, parseInt(quantity, 10) || 1);

  const [campaigns] = await db.query(
    "SELECT * FROM campaign WHERE product_id = ? AND status = 'ACTIVE' AND (end_time IS NULL OR end_time > NOW()) LIMIT 1",
    [productId]
  );
  if (!campaigns.length) {
    const e = new Error('No active campaign found for this product');
    e.status = 404;
    throw e;
  }
  const campaign = campaigns[0];

  // Insert one row per unit
  for (let i = 0; i < quantity; i++) {
    await db.query(
      'INSERT INTO campaign_hold (campaign_id, customer_id, product_id) VALUES (?,?,?)',
      [campaign.id, customerId, productId]
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
     JOIN product p ON p.id = ch.product_id AND p.active = 0
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

  // Group by customer so we know how many slots each customer has
  const [holderGroups] = await db.query(
    `SELECT customer_id, product_id, COUNT(*) AS slot_count
     FROM campaign_hold
     WHERE campaign_id = ?
     GROUP BY customer_id, product_id`,
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
      "SELECT id, quantity, deposit_paid FROM cart WHERE customer_id = ? AND product_id = ? AND price_type = 'DEAL'",
      [h.customer_id, h.product_id]
    );

    let notificationMessage;
    if (existingDealRow.length === 0) {
      // First time deal completes for this customer — insert with correct quantity and deposit
      await db.query(
        `INSERT INTO cart (customer_id, product_id, quantity, price_type, locked_price, deposit_paid)
         VALUES (?, ?, ?, 'DEAL', ?, ?)`,
        [h.customer_id, h.product_id, slotCount, lockedPrice, depositPaid]
      );
      notificationMessage = `The group deal for "${productName}" has been fulfilled! ${slotCount} unit${slotCount > 1 ? 's have' : ' has'} been added to your cart at the group deal price.`;
    } else {
      // Add to existing DEAL row — accumulate the new batch's deposit on top
      const prevDeposit = Number(existingDealRow[0].deposit_paid) || 0;
      await db.query(
        "UPDATE cart SET quantity = quantity + ?, deposit_paid = ? WHERE customer_id = ? AND product_id = ? AND price_type = 'DEAL'",
        [slotCount, prevDeposit + depositPaid, h.customer_id, h.product_id]
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
  }

  await db.query('DELETE FROM campaign_hold WHERE campaign_id = ?', [campaign.id]);

  const [stockRows] = await db.query(
    'SELECT stock_quantity, hold_target, seller_id FROM product WHERE id = ? AND active = 1',
    [campaign.product_id]
  );
  if (stockRows.length && stockRows[0].stock_quantity > 0) {
    // Use campaign's own target/prices (set via seller portal); fall back to product table
    const newTarget      = (campaign.target > 0 ? campaign.target : stockRows[0].hold_target) || 0;
    const newHoldPrice   = campaign.hold_price   || null;
    const newRetailPrice = campaign.retail_price || null;
    if (newTarget > 0) {
      await db.query(
        `INSERT INTO campaign (product_id, seller_id, target, current_hold, status, start_time, hold_price, retail_price)
         VALUES (?, ?, ?, 0, 'ACTIVE', NOW(), ?, ?)`,
        [campaign.product_id, stockRows[0].seller_id, newTarget, newHoldPrice, newRetailPrice]
      );
    }
  }
}