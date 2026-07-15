import db from '../config/db.js';

// Same logic used by orderService for seller-uploaded product images.
const resolveImage = (raw) => {
  if (!raw) return null;
  let first = raw;
  if (String(raw).startsWith('[')) {
    try { first = JSON.parse(raw).filter(Boolean)[0] || raw; } catch { /* ignore */ }
  }
  if (first.startsWith('http')) return first;
  return first.startsWith('/uploads')
    ? first.replace('/uploads', '/seller-uploads')
    : `/seller-uploads${first.startsWith('/') ? '' : '/'}${first}`;
};

// Auto-create the customer_complaint table if it doesn't exist
(async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS customer_complaint (
        id                  SERIAL PRIMARY KEY,
        customer_id         INT          NOT NULL,
        order_id            INT          DEFAULT NULL,
        subject             VARCHAR(255) NOT NULL,
        description         TEXT         NOT NULL,
        status              VARCHAR(50)  NOT NULL DEFAULT 'Open',
        seller_complaint_id INT          DEFAULT NULL,
        created_date        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        resolved_date       TIMESTAMP    DEFAULT NULL
      )
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_customer ON customer_complaint (customer_id)
    `);
  } catch (e) {
    console.error('[complaintService] table init error:', e.message);
  }

  // Backfill the link column for tables created before this change.
  // IF NOT EXISTS makes this safe to call every time.
  try {
    await db.query(`
      ALTER TABLE customer_complaint
      ADD COLUMN IF NOT EXISTS seller_complaint_id INT DEFAULT NULL
    `);
  } catch (e) {
    console.error('[complaintService] column backfill error:', e.message);
  }

  // The seller-side "complaint" table previously had no dedicated subject
  // column, so the subject line was being prepended into the description
  // text instead. Add the column (safe to call multiple times) so the
  // subject can be forwarded on its own.
  try {
    await db.query(`
      ALTER TABLE complaint
      ADD COLUMN IF NOT EXISTS subject VARCHAR(255) DEFAULT NULL
    `);
  } catch (e) {
    console.error('[complaintService] subject column backfill error:', e.message);
  }
})();

export const submitComplaint = async ({ customerId, orderId, subject, description }) => {
  // If this complaint is tied to an order, block a second complaint for the
  // same product while an earlier one is still Open / In Progress.
  if (orderId) {
    const [productRows] = await db.query(
      'SELECT product_id FROM orders WHERE id = ? AND customer_id = ?',
      [orderId, customerId]
    );
    const productId = productRows[0]?.product_id;
    if (productId) {
      const [existingRows] = await db.query(
        `SELECT cc.id FROM customer_complaint cc
         JOIN orders o ON o.id = cc.order_id
         WHERE cc.customer_id = ? AND o.product_id = ?
           AND cc.status IN ('Open', 'In Progress')
         LIMIT 1`,
        [customerId, productId]
      );
      if (existingRows[0]) {
        throw Object.assign(
          new Error('You already have a complaint in review for this product'),
          { statusCode: 409 }
        );
      }
    }
  }

  const [result] = await db.query(
    `INSERT INTO customer_complaint (customer_id, order_id, subject, description, status, created_date)
     VALUES (?, ?, ?, ?, 'Open', NOW())`,
    [customerId, orderId || null, subject, description]
  );
  const complaintId = result.insertId;

  // Forward to the seller's complaint queue, if this complaint is tied to an order.
  if (orderId) {
    try {
      const [orderRows] = await db.query(
        'SELECT seller_id, customer_name FROM orders WHERE id = ? AND customer_id = ?',
        [orderId, customerId]
      );
      const order = orderRows[0];

      if (order?.seller_id) {
        const [sellerResult] = await db.query(
          `INSERT INTO complaint
             (seller_id, order_id, customer_name, type, priority, status, subject, description)
           VALUES (?, ?, ?, 'Customer Complaint', 'Medium', 'Open', ?, ?)`,
          [
            order.seller_id,
            orderId,
            order.customer_name || 'Customer',
            subject,
            description,
          ]
        );

        await db.query(
          'UPDATE customer_complaint SET seller_complaint_id = ? WHERE id = ?',
          [sellerResult.insertId, complaintId]
        );
      }
    } catch (e) {
      // Don't fail the customer's submission if the seller-side link fails —
      // log it so it can be investigated/backfilled.
      console.error('[complaintService] failed to forward complaint to seller:', e.message);
    }
  }

  return { id: complaintId, message: 'Complaint submitted successfully' };
};

export const listComplaints = async (customerId) => {
  // LEFT JOIN to the seller's complaint table via seller_complaint_id so the
  // customer can see the seller's resolution note once it's been resolved.
  // Also LEFT JOIN to orders so we can show the real order number (e.g.
  // "HK1781848825227") instead of the internal numeric order_id, and LEFT
  // JOIN to product so the ticket can show what the complaint is actually about.
  const [rows] = await db.query(
    `SELECT cc.id, cc.order_id, cc.subject, cc.description, cc.status,
            cc.created_date, cc.resolved_date,
            o.order_number, o.product_id, o.product_name,
            p.image_url AS product_image_raw,
            c.resolution AS seller_resolution
     FROM customer_complaint cc
     LEFT JOIN orders o ON o.id = cc.order_id
     LEFT JOIN product p ON p.id = o.product_id
     LEFT JOIN complaint c ON c.id = cc.seller_complaint_id
     WHERE cc.customer_id = ?
     ORDER BY cc.created_date DESC`,
    [customerId]
  );
  return rows.map(r => {
    const { product_image_raw, ...rest } = r;
    return { ...rest, product_image: resolveImage(product_image_raw) };
  });
};