import db from '../config/db.js';

/**
 * Ensure the customer_transaction table exists.
 * Called once at startup and before any insert — safe to run multiple times.
 */
export const ensureTable = async () => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS customer_transaction (
      id             SERIAL PRIMARY KEY,
      customer_id    INT          NOT NULL,
      order_id       INT          DEFAULT NULL,
      order_number   VARCHAR(50)  DEFAULT NULL,
      amount         DECIMAL(10,2) NOT NULL,
      type           VARCHAR(30)  NOT NULL DEFAULT 'DEBIT',
      method         VARCHAR(30)  DEFAULT NULL,
      status         VARCHAR(30)  NOT NULL DEFAULT 'SUCCESS',
      description    VARCHAR(500) DEFAULT NULL,
      cashfree_order_id VARCHAR(100) DEFAULT NULL,
      created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_customer_txn_customer ON customer_transaction (customer_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_customer_txn_order ON customer_transaction (order_id)`);
};

/**
 * Record a customer transaction.
 *
 * @param {object} params
 * @param {number} params.customerId
 * @param {number} [params.orderId]
 * @param {string} [params.orderNumber]
 * @param {number} params.amount
 * @param {string} [params.type]            DEBIT | REFUND | COD
 * @param {string} [params.method]          Online | COD
 * @param {string} [params.status]          SUCCESS | PENDING | FAILED
 * @param {string} [params.description]
 * @param {string} [params.cashfreeOrderId]
 */
export const record = async ({
  customerId,
  orderId          = null,
  orderNumber      = null,
  amount,
  type             = 'DEBIT',
  method           = null,
  status           = 'SUCCESS',
  description      = '',
  cashfreeOrderId  = null,
}) => {
  await ensureTable();

  const [result] = await db.query(
    `INSERT INTO customer_transaction
       (customer_id, order_id, order_number, amount, type, method,
        status, description, cashfree_order_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [customerId, orderId, orderNumber, amount, type, method,
     status, description, cashfreeOrderId]
  );

  return { transactionId: result.insertId };
};

/**
 * Fetch all transactions for a customer, newest first.
 */
export const listByCustomer = async (customerId) => {
  await ensureTable();

  const [rows] = await db.query(
    `SELECT * FROM customer_transaction
     WHERE customer_id = ?
     ORDER BY created_at DESC`,
    [customerId]
  );
  return rows;
};