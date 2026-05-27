import db from '../config/db.js';

  export const submitComplaint = async ({ customerId, orderId, subject, description }) => {
    await db.query(
      'INSERT INTO customer_complaint (customer_id, order_id, subject, description) VALUES (?,?,?,?)',
      [customerId, orderId || null, subject, description]
    );
    return { message: 'Complaint submitted successfully' };
  };

  export const listComplaints = async (customerId) => {
    const [rows] = await db.query(
      'SELECT * FROM customer_complaint WHERE customer_id=? ORDER BY created_date DESC',
      [customerId]
    );
    return rows;
  };
  