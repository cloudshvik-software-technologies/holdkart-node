import db from '../config/db.js';
import * as txSvc from './transactionService.js';

// Ensure deposit_amount column exists in campaign_hold (safe to run multiple times)
(async () => {
  try {
    await db.query(
      `ALTER TABLE campaign_hold ADD COLUMN IF NOT EXISTS deposit_amount DECIMAL(10,2) NOT NULL DEFAULT 0`
    );
  } catch (e) {
    // Ignore if column already exists (older MySQL without IF NOT EXISTS support)
    if (!e.message?.includes('Duplicate column')) {
      console.error('[campaignService] migration warning:', e.message);
    }
  }
})();

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
    'SELECT id, seller_id FROM product WHERE id = ? AND active = 1',
    [productId]
  );
  if (!products.length) { const e = new Error('Product not found or no longer available'); e.status = 404; throw e; }
  const product = products[0];

  // Fetch the active campaign — seller creates campaigns, so we rely on the campaign
  // table for target/hold_price rather than the product table columns.
  let [campaigns] = await db.query(
    "SELECT * FROM campaign WHERE product_id = ? AND status = 'ACTIVE' AND (end_time IS NULL OR end_time > NOW()) LIMIT 1",
    [productId]
  );

  let campaign = campaigns[0];

  if (!campaign) {
    const e = new Error('No active campaign found for this product');
    e.status = 404;
    throw e;
  }

  if (!campaign.target || campaign.target <= 0) {
    const e = new Error('This product does not support group deals');
    e.status = 400;
    throw e;
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

  // Calculate deposit per unit from current prices (or use the actual paid amount from frontend)
  const [priceRowsJoin] = await db.query(
    'SELECT retail_price, hold_price, product_name FROM product WHERE id = ?',
    [productId]
  );
  const retailPriceJoin   = priceRowsJoin.length ? Number(priceRowsJoin[0].retail_price) : 0;
  const holdPriceJoin     = priceRowsJoin.length ? Number(priceRowsJoin[0].hold_price)   : 0;
  const calcDepositPerUnit = Math.max(0, retailPriceJoin - holdPriceJoin);
  // If frontend sent the actual paid amount, divide it evenly per slot
  const depositPerUnitJoin = depositAmount
    ? (Number(depositAmount) / quantity)
    : calcDepositPerUnit;

  // Insert one row per unit, recording the per-slot deposit actually paid
  for (let i = 0; i < quantity; i++) {
    await db.query(
      'INSERT INTO campaign_hold (campaign_id, customer_id, product_id, deposit_amount) VALUES (?,?,?,?)',
      [campaign.id, customerId, productId, depositPerUnitJoin]
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
    if (priceRowsJoin.length) {
      const productName  = priceRowsJoin[0].product_name;
      const totalDeposit = depositPerUnitJoin * quantity;
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

  // Calculate deposit per unit from actual paid amount or current prices
  const [priceRowsAdd] = await db.query(
    'SELECT retail_price, hold_price, product_name FROM product WHERE id = ?',
    [productId]
  );
  const retailPriceAdd    = priceRowsAdd.length ? Number(priceRowsAdd[0].retail_price) : 0;
  const holdPriceAdd      = priceRowsAdd.length ? Number(priceRowsAdd[0].hold_price)   : 0;
  const calcDepositPerAdd = Math.max(0, retailPriceAdd - holdPriceAdd);
  const depositPerUnitAdd = depositAmount
    ? (Number(depositAmount) / quantity)
    : calcDepositPerAdd;

  // Insert one row per unit, recording the per-slot deposit actually paid
  for (let i = 0; i < quantity; i++) {
    await db.query(
      'INSERT INTO campaign_hold (campaign_id, customer_id, product_id, deposit_amount) VALUES (?,?,?,?)',
      [campaign.id, customerId, productId, depositPerUnitAdd]
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
    if (priceRowsAdd.length) {
      const productName  = priceRowsAdd[0].product_name;
      const totalDeposit = depositPerUnitAdd * quantity;
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

  // Group by customer — sum actual deposit_amount paid per slot (stored at join time)
  const [holderGroups] = await db.query(
    `SELECT customer_id, product_id, COUNT(*) AS slot_count, SUM(deposit_amount) AS total_deposit_paid
     FROM campaign_hold
     WHERE campaign_id = ?
     GROUP BY customer_id, product_id`,
    [campaign.id]
  );

  const [priceRows] = await db.query('SELECT retail_price, hold_price, product_name FROM product WHERE id = ?', [campaign.product_id]);
  const lockedPrice   = priceRows[0]?.hold_price   ?? null;
  const productName   = priceRows[0]?.product_name || 'the product';

  for (const h of holderGroups) {
    const slotCount   = h.slot_count;
    // Use the actual deposit sum stored at join time — not recalculated from current prices
    const depositPaid = Number(h.total_deposit_paid) || 0;

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
    'SELECT stock_quantity, seller_id FROM product WHERE id = ? AND active = 1',
    [campaign.product_id]
  );
  // Use campaign.target for the new cycle — product.hold_target may be 0 if seller
  // manages prices only through campaigns.
  if (stockRows.length && stockRows[0].stock_quantity > 0) {
    await db.query(
      `INSERT INTO campaign (product_id, seller_id, target, current_hold, status, start_time)
       VALUES (?, ?, ?, 0, 'ACTIVE', NOW())`,
      [campaign.product_id, stockRows[0].seller_id, campaign.target]
    );
  }
}