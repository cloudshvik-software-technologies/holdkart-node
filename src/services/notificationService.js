import db from '../config/db.js';

  export const getNotifications = async (customerId) => {
    const [rows] = await db.query(
      'SELECT * FROM customer_notification WHERE customer_id = ? ORDER BY created_date DESC LIMIT 50',
      [customerId]
    );
    return rows;
  };

  export const markRead = async ({ customerId, notificationId }) => {
    if (notificationId) {
      await db.query('UPDATE customer_notification SET is_read=1 WHERE id=? AND customer_id=?', [notificationId, customerId]);
    } else {
      await db.query('UPDATE customer_notification SET is_read=1 WHERE customer_id=?', [customerId]);
    }
    return { message: 'Marked as read' };
  };

  export const getUnreadCount = async (customerId) => {
    const [rows] = await db.query('SELECT COUNT(*) AS cnt FROM customer_notification WHERE customer_id=? AND is_read=0', [customerId]);
    return { count: rows[0].cnt };
  };
  