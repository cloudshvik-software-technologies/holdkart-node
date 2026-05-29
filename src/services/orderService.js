import db from '../config/db.js';

  const genOrderNumber = () => 'HK' + Date.now();

  export const placeOrder = async ({ customerId, items, address, city, pincode, state, paymentMethod = 'COD', paymentId = null }) => {
    if (!items || !items.length) throw new Error('No items in order');

    const results = [];
    for (const item of items) {
      const [prows] = await db.query('SELECT * FROM product WHERE id = ? AND active = 1', [item.productId]);
      if (!prows.length) throw Object.assign(new Error(`Product ${item.productId} not found`), { status: 404 });
      const p = prows[0];
      if (p.stock_quantity < item.quantity) throw Object.assign(new Error(`Insufficient stock for ${p.product_name}`), { status: 400 });

      const [crows] = await db.query('SELECT * FROM customer WHERE id = ?', [customerId]);
      const customer = crows[0];
      const orderNumber = genOrderNumber();
      const amount = p.retail_price * item.quantity;

      const [r] = await db.query(
        `INSERT INTO orders (order_number, product_id, seller_id, customer_id, quantity, order_amount,
          order_status, order_date, payment_status, delivery_status, address, category,
          product_name, customer_name, created_date, payment_method, customer_email, customer_phone, city, pincode, state)
         VALUES (?,?,?,?,?,?,'Pending',NOW(),?,?,?,?,?,?,NOW(),?,?,?,?,?,?)`,
        [orderNumber, p.id, p.seller_id, customerId, item.quantity, amount,
         paymentMethod === 'Online' ? 'Paid' : 'Pending',
         'Pending', address, p.category, p.product_name,
         customer?.name || '', paymentMethod,
         customer?.email || '', customer?.mobile || '', city, pincode, state]
      );

      // Reduce stock
      await db.query('UPDATE product SET stock_quantity = stock_quantity - ? WHERE id = ?', [item.quantity, p.id]);

      // If the customer was holding in an active campaign for this product,
      // remove their hold now that they've ordered — freeing the slot for others.
      const [activeCampaigns] = await db.query(
        "SELECT id FROM campaign WHERE product_id = ? AND status = 'ACTIVE' LIMIT 1",
        [p.id]
      );
      if (activeCampaigns.length) {
        const campaignId = activeCampaigns[0].id;
        const [holdRow] = await db.query(
          'SELECT id FROM campaign_hold WHERE campaign_id = ? AND customer_id = ?',
          [campaignId, customerId]
        );
        if (holdRow.length) {
          await db.query(
            'DELETE FROM campaign_hold WHERE campaign_id = ? AND customer_id = ?',
            [campaignId, customerId]
          );
          await db.query(
            'UPDATE campaign SET current_hold = GREATEST(0, current_hold - 1) WHERE id = ?',
            [campaignId]
          );
        }
      }

      // Notify customer
      await db.query(
        'INSERT INTO customer_notification (customer_id, title, message, type) VALUES (?,?,?,?)',
        [customerId, 'Order Placed!', `Your order ${orderNumber} for ${p.product_name} has been placed.`, 'ORDER']
      );

      results.push({ orderId: r.insertId, orderNumber, productName: p.product_name, amount });
    }

    // Clear cart
    await db.query('DELETE FROM cart WHERE customer_id = ?', [customerId]);

    return { message: 'Order placed successfully', orders: results };
  };

  export const listOrders = async (customerId) => {
    const [rows] = await db.query(
      `SELECT o.*, s.business_name AS sellerName
       FROM orders o LEFT JOIN seller s ON s.id = o.seller_id
       WHERE o.customer_id = ? ORDER BY o.created_date DESC`,
      [customerId]
    );
    return rows;
  };

  export const getOrder = async (orderId, customerId) => {
    const [rows] = await db.query(
      `SELECT o.*, s.business_name AS sellerName, s.email AS sellerEmail
       FROM orders o LEFT JOIN seller s ON s.id = o.seller_id
       WHERE o.id = ? AND o.customer_id = ?`,
      [orderId, customerId]
    );
    return rows[0] || null;
  };

  export const cancelOrder = async ({ orderId, customerId }) => {
    const [rows] = await db.query('SELECT * FROM orders WHERE id = ? AND customer_id = ?', [orderId, customerId]);
    if (!rows.length) { const e = new Error('Order not found'); e.status = 404; throw e; }
    const order = rows[0];
    if (!['Pending', 'Confirmed'].includes(order.order_status)) {
      const e = new Error('Cannot cancel order in current status'); e.status = 400; throw e;
    }
    await db.query("UPDATE orders SET order_status = 'Cancelled' WHERE id = ?", [orderId]);
    // Restore stock
    await db.query('UPDATE product SET stock_quantity = stock_quantity + ? WHERE id = ?', [order.quantity, order.product_id]);
    return { message: 'Order cancelled successfully' };
  };
  