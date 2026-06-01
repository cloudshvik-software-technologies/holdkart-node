import db from '../config/db.js';

export const listCampaigns = async () => {
  const [rows] = await db.query(
    `SELECT c.*, p.product_name, p.image_url, p.retail_price, p.hold_price, p.description,
            s.business_name AS sellerName,
            ROUND((c.current_hold / c.target) * 100) AS progressPct
     FROM campaign c
     JOIN product p ON p.id = c.product_id
     JOIN seller s ON s.id = c.seller_id
     WHERE c.status = 'ACTIVE' AND (c.end_time IS NULL OR c.end_time > NOW())
     ORDER BY c.start_time DESC`
  );
  return rows;
};

export const joinCampaign = async ({ customerId, campaignId }) => {
  const [rows] = await db.query('SELECT * FROM campaign WHERE id = ? AND status = ?', [campaignId, 'ACTIVE']);
  if (!rows.length) { const e = new Error('Campaign not found or inactive'); e.status = 404; throw e; }
  const c = rows[0];

  const [existing] = await db.query(
    'SELECT id FROM campaign_hold WHERE campaign_id = ? AND customer_id = ?',
    [campaignId, customerId]
  );
  if (existing.length) { const e = new Error('You have already joined this campaign'); e.status = 409; throw e; }

  await db.query(
    'INSERT INTO campaign_hold (campaign_id, customer_id, product_id) VALUES (?,?,?)',
    [campaignId, customerId, c.product_id]
  );

  await db.query('UPDATE campaign SET current_hold = current_hold + 1 WHERE id = ? AND current_hold < target', [campaignId]);

  const [updated] = await db.query('SELECT * FROM campaign WHERE id = ?', [campaignId]);
  if (updated[0] && updated[0].current_hold >= updated[0].target) {
    await _completeCampaignAndReset(updated[0]);
  }

  return { message: 'You have joined the hold campaign!' };
};

export const leaveCampaign = async ({ customerId, campaignId }) => {
  const [rows] = await db.query('SELECT * FROM campaign WHERE id = ? AND status = ?', [campaignId, 'ACTIVE']);
  if (!rows.length) { const e = new Error('Cannot leave a completed or inactive campaign'); e.status = 400; throw e; }

  const [existing] = await db.query(
    'SELECT id FROM campaign_hold WHERE campaign_id = ? AND customer_id = ?',
    [campaignId, customerId]
  );
  if (!existing.length) { const e = new Error('You have not joined this campaign'); e.status = 404; throw e; }

  await db.query(
    'DELETE FROM campaign_hold WHERE campaign_id = ? AND customer_id = ?',
    [campaignId, customerId]
  );

  await db.query(
    'UPDATE campaign SET current_hold = GREATEST(0, current_hold - 1) WHERE id = ?',
    [campaignId]
  );

  return { message: 'You have left the campaign' };
};

/**
 * getMyCampaigns — returns only ACTIVE campaigns the customer has joined.
 * Completed campaigns are excluded so the Home "My Hold Deals" section only
 * shows ongoing holds.
 */
export const getMyCampaigns = async (customerId) => {
  const [rows] = await db.query(
    `SELECT ch.id AS holdId, ch.campaign_id, c.id, ch.customer_id, ch.product_id, ch.joined_date,
            c.status AS campaignStatus, c.target, c.current_hold,
            p.product_name, p.image_url, p.retail_price, p.hold_price
     FROM campaign_hold ch
     JOIN campaign c ON c.id = ch.campaign_id
     JOIN product p ON p.id = ch.product_id
     WHERE ch.customer_id = ? AND c.status = 'ACTIVE'
     ORDER BY ch.joined_date DESC`,
    [customerId]
  );
  return rows;
};

export const getCampaignById = async (campaignId) => {
  const [rows] = await db.query(
    `SELECT c.*, p.product_name, p.image_url, p.retail_price, p.hold_price, p.description,
            s.business_name AS sellerName,
            ROUND((c.current_hold / c.target) * 100) AS progressPct
     FROM campaign c
     JOIN product p ON p.id = c.product_id
     JOIN seller s  ON s.id = c.seller_id
     WHERE c.id = ?`,
    [campaignId]
  );
  if (!rows.length) { const e = new Error('Campaign not found'); e.status = 404; throw e; }
  return rows[0];
};

export const startOrJoinCampaign = async ({ customerId, productId }) => {
  const [products] = await db.query(
    'SELECT id, seller_id, hold_target FROM product WHERE id = ? AND active = 1',
    [productId]
  );
  if (!products.length) { const e = new Error('Product not found'); e.status = 404; throw e; }
  const product = products[0];

  if (!product.hold_target || product.hold_target <= 0) {
    const e = new Error('This product does not support group deals');
    e.status = 400;
    throw e;
  }

  let [campaigns] = await db.query(
    "SELECT * FROM campaign WHERE product_id = ? AND status = 'ACTIVE' AND (end_time IS NULL OR end_time > NOW()) LIMIT 1",
    [productId]
  );

  let campaign = campaigns[0];

  if (!campaign) {
    // No active campaign — create a fresh one (new round)
    const [result] = await db.query(
      `INSERT INTO campaign (product_id, seller_id, target, current_hold, status, start_time)
       VALUES (?, ?, ?, 0, 'ACTIVE', NOW())`,
      [productId, product.seller_id, product.hold_target]
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

  await db.query(
    'INSERT INTO campaign_hold (campaign_id, customer_id, product_id) VALUES (?,?,?)',
    [campaign.id, customerId, productId]
  );

  await db.query(
    'UPDATE campaign SET current_hold = current_hold + 1 WHERE id = ? AND current_hold < target',
    [campaign.id]
  );

  const [updated] = await db.query('SELECT * FROM campaign WHERE id = ?', [campaign.id]);
  if (updated[0] && updated[0].current_hold >= updated[0].target) {
    await _completeCampaignAndReset(updated[0]);
  }

  return { message: 'You have joined the group deal!', campaignId: campaign.id };
};

/**
 * Internal helper: called when a campaign reaches its target.
 *
 * 1. Marks the campaign as COMPLETED.
 * 2. Adds the product to cart for every participant.
 * 3. Sends a notification to every participant.
 * 4. Clears campaign_hold rows for this campaign.
 * 5. Creates a brand-new ACTIVE campaign round for the same product
 *    (only if there is still stock remaining).
 */
async function _completeCampaignAndReset(campaign) {
  // Step 1 — mark COMPLETED
  await db.query("UPDATE campaign SET status = 'COMPLETED' WHERE id = ?", [campaign.id]);

  // Step 2 — fetch all participants
  const [holders] = await db.query(
    'SELECT customer_id, product_id FROM campaign_hold WHERE campaign_id = ?',
    [campaign.id]
  );

  // Step 3 — add product to each participant's cart & notify them
  for (const h of holders) {
    // Add to cart (upsert)
    await db.query(
      `INSERT INTO cart (customer_id, product_id, quantity)
       VALUES (?, ?, 1)
       ON DUPLICATE KEY UPDATE quantity = quantity + 1`,
      [h.customer_id, h.product_id]
    );

    // Notify
    const [prows] = await db.query('SELECT product_name FROM product WHERE id = ?', [h.product_id]);
    const productName = prows[0]?.product_name || 'the product';
    await db.query(
      `INSERT INTO customer_notification (customer_id, title, message, type)
       VALUES (?, ?, ?, ?)`,
      [
        h.customer_id,
        '🎉 Group Deal Complete!',
        `The group deal for "${productName}" has been fulfilled! It has been added to your cart. Complete your order now to get the group discount.`,
        'CAMPAIGN',
      ]
    );
  }

  // Step 4 — clear campaign_hold rows (campaign is done)
  await db.query('DELETE FROM campaign_hold WHERE campaign_id = ?', [campaign.id]);

  // Step 5 — check stock and start a new round if stock remains
  const [stockRows] = await db.query(
    'SELECT stock_quantity, hold_target, seller_id FROM product WHERE id = ?',
    [campaign.product_id]
  );
  if (stockRows.length && stockRows[0].stock_quantity > 0) {
    await db.query(
      `INSERT INTO campaign (product_id, seller_id, target, current_hold, status, start_time)
       VALUES (?, ?, ?, 0, 'ACTIVE', NOW())`,
      [campaign.product_id, stockRows[0].seller_id, stockRows[0].hold_target]
    );
  }
}