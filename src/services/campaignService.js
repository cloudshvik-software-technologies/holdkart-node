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
    await db.query("UPDATE campaign SET status = 'COMPLETED' WHERE id = ?", [campaignId]);
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

export const getMyCampaigns = async (customerId) => {
  const [rows] = await db.query(
    `SELECT ch.*, c.status AS campaignStatus, c.target, c.current_hold,
            p.product_name, p.image_url, p.retail_price, p.hold_price
     FROM campaign_hold ch
     JOIN campaign c ON c.id = ch.campaign_id
     JOIN product p ON p.id = ch.product_id
     WHERE ch.customer_id = ? ORDER BY ch.joined_date DESC`,
    [customerId]
  );
  return rows;
};

/**
 * Start a campaign for a product if none is active, then immediately join it.
 * Looks up the seller_id from the product table so no seller interaction is needed.
 */
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
    await db.query("UPDATE campaign SET status = 'COMPLETED' WHERE id = ?", [campaign.id]);
  }

  return { message: 'You have joined the group deal!', campaignId: campaign.id };
};
