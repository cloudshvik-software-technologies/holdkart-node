import db from '../config/db.js';

const parseImages = (raw) => {
  if (!raw) return [];
  if (String(raw).startsWith('[')) { try { return JSON.parse(raw).filter(Boolean); } catch {} }
  return [raw];
};

export const addToWishlist = async ({ customerId, productId }) => {
  await db.query(
    `INSERT INTO wishlist (customer_id, product_id) VALUES (?, ?)
     ON CONFLICT (customer_id, product_id) DO NOTHING`,
    [customerId, productId]
  );
  return { message: 'Added to wishlist' };
};

export const getWishlist = async (customerId) => {
  const [rows] = await db.query(
    `SELECT w.id, w.product_id, w.added_date,
            p.product_name AS name,
            p.retail_price AS "retailPrice",
            p.hold_price   AS "holdPrice",
            p.image_url,
            p.stock_quantity AS stock,
            p.category,
            p.active,
            /* live campaign data — NULL when no active campaign */
            EXISTS (
              SELECT 1 FROM campaign ca
              WHERE ca.product_id = p.id AND ca.status = 'ACTIVE'
            ) AS "hasCampaign",
            COALESCE((
              SELECT ca2.hold_price FROM campaign ca2
              WHERE ca2.product_id = p.id AND ca2.status = 'ACTIVE'
              AND ca2.hold_price > 0 LIMIT 1
            ), p.hold_price) AS "campaignHoldPrice",
            COALESCE((
              SELECT ca2.target FROM campaign ca2
              WHERE ca2.product_id = p.id AND ca2.status = 'ACTIVE'
              AND ca2.target > 0 LIMIT 1
            ), p.hold_target) AS "holdTarget",
            COALESCE((
              SELECT COUNT(ch.id) FROM campaign_hold ch
              JOIN campaign ca3 ON ca3.product_id = p.id AND ca3.id = ch.campaign_id
              WHERE ca3.status = 'ACTIVE'
            ), 0) AS "currentHold",
            COALESCE((
              SELECT ca4.retail_price FROM campaign ca4
              WHERE ca4.product_id = p.id AND ca4.status = 'ACTIVE' LIMIT 1
            ), p.retail_price) AS "campaignRetailPrice"
     FROM wishlist w
     JOIN product p ON p.id = w.product_id AND p.active = true
     WHERE w.customer_id = ?
     ORDER BY w.added_date DESC`,
    [customerId]
  );
  return rows.map(r => ({
    wishlistId:   r.id,
    productId:    r.product_id,
    name:         r.name,
    retailPrice:  Number(r.campaignRetailPrice) || Number(r.retailPrice),
    holdPrice:    Number(r.campaignHoldPrice)   || Number(r.holdPrice),
    holdTarget:   Number(r.holdTarget)  || 0,
    currentHold:  Number(r.currentHold) || 0,
    hasCampaign:  Number(r.hasCampaign) === 1,
    imageUrl:     parseImages(r.image_url)[0] || null,
    stock:        r.stock,
    category:     r.category,
    active:       Boolean(r.active),
  }));
};

export const removeFromWishlist = async ({ customerId, productId }) => {
  await db.query('DELETE FROM wishlist WHERE customer_id = ? AND product_id = ?', [customerId, productId]);
  return { message: 'Removed from wishlist' };
};