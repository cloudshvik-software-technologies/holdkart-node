import db from '../config/db.js';

// Auto-create the customer_complaint table if it doesn't exist
(async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS customer_complaint (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        customer_id    INT          NOT NULL,
        order_id       INT          DEFAULT NULL,
        subject        VARCHAR(255) NOT NULL,
        description    TEXT         NOT NULL,
        status         VARCHAR(50)  NOT NULL DEFAULT 'Open',
        created_date   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        resolved_date  DATETIME     DEFAULT NULL,
        INDEX idx_customer (customer_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  } catch (e) {
    console.error('[complaintService] table init error:', e.message);
  }
})();

export const submitComplaint = async ({ customerId, orderId, subject, description }) => {
  const [result] = await db.query(
    `INSERT INTO customer_complaint (customer_id, order_id, subject, description, status, created_date)
     VALUES (?, ?, ?, ?, 'Open', NOW())`,
    [customerId, orderId || null, subject, description]
  );
  return { id: result.insertId, message: 'Complaint submitted successfully' };
};

export const listComplaints = async (customerId) => {
  const [rows] = await db.query(
    `SELECT id, order_id, subject, description, status, created_date, resolved_date
     FROM customer_complaint
     WHERE customer_id = ?
     ORDER BY created_date DESC`,
    [customerId]
  );
  return rows;
};