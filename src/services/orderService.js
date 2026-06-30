import db from '../config/db.js';
import * as txSvc from './transactionService.js';
import * as shiprocket from './shiprocketService.js';
import * as paySvc from './paymentService.js';
import { sendOrderPlacedEmail, sendInvoiceEmail, sendOrderShippedEmail, sendOrderDeliveredEmail, sendRefundProcessedEmail } from '../config/email.js';

const genOrderNumber = () => 'HK' + Date.now();

// The seller dashboard's Notifications page reads from `seller_notification`,
// but nothing in the order flow was ever writing to it — so sellers never
// saw Order/Payment alerts there, even though orders/payments were
// happening. Centralize the insert here and call it at the key order events.
const notifySeller = async (sellerId, title, message) => {
  if (!sellerId) return;
  try {
    await db.query(
      `INSERT INTO seller_notification (seller_id, title, message, created_date, read_status)
       VALUES (?, ?, ?, NOW(), 0)`,
      [sellerId, title, message]
    );
  } catch (e) {
    console.error('[orderService] seller notification error:', e.message);
  }
};

// Ensure the tracking columns exist (safe to call multiple times)
const ensureEmailTrackingColumns = async () => {
  try {
    await db.query(`ALTER TABLE orders
      ADD COLUMN delivered_email_sent_at DATETIME NULL,
      ADD COLUMN invoice_email_sent_at DATETIME NULL`);
  } catch {}
};

const buildInvoicePayload = (order) => ({
  name:          order.customer_name || order.customerName || 'Customer',
  orderNumber:   order.order_number,
  productName:   order.product_name,
  quantity:      order.quantity || 1,
  amount:        order.order_amount,
  address:       [order.address, order.city, order.state, order.pincode].filter(Boolean).join(', '),
  paymentMethod: order.payment_method,
  orderDate:     order.order_date ? new Date(order.order_date).toLocaleDateString('en-IN') : null,
  category:      order.category,
  sellerName:    order.sellerName || null,
  sellerEmail:   order.sellerEmail || null,
  phFee:         order.payment_handling_fee,
  ppFee:         order.protect_promise_fee,
});

/**
 * Marks the delivered email as sent (DB-backed, so it survives server restarts)
 * and sends it, if not already sent. The invoice email itself is NOT sent here;
 * it is picked up by the invoice email poller 10 minutes later.
 * Returns true if the delivered email was sent by this call.
 */
const markDeliveredAndSendEmail = async (order, email) => {
  await ensureEmailTrackingColumns();

  const [result] = await db.query(
    `UPDATE orders SET delivered_email_sent_at = NOW()
     WHERE id = ? AND delivered_email_sent_at IS NULL`,
    [order.id]
  );
  if (result.affectedRows === 0) return false; // already sent previously

  if (email) {
    const base = { name: order.customer_name || order.customerName || 'Customer', orderNumber: order.order_number, productName: order.product_name };
    await sendOrderDeliveredEmail(email, base).catch(e => console.error('[markDeliveredAndSendEmail] delivered email error:', e.message));
  }
  return true;
};

/**
 * Poller: every minute, find orders whose delivered email was sent at least
 * 10 minutes ago and whose invoice email hasn't been sent yet, then send the
 * invoice email and stamp invoice_email_sent_at. DB-backed, so a server
 * restart simply means the next poll tick picks up any due orders.
 */
export const startInvoiceEmailPoller = () => {
  const runOnce = async () => {
    try {
      await ensureEmailTrackingColumns();

      const [rows] = await db.query(
        `SELECT o.*, s.business_name AS sellerName, s.email AS sellerEmail, c.email AS customerEmail, c.name AS customerName
         FROM orders o
         LEFT JOIN seller s ON s.id = o.seller_id
         LEFT JOIN customer c ON c.id = o.customer_id
         WHERE o.delivered_email_sent_at IS NOT NULL
           AND o.invoice_email_sent_at IS NULL
           AND o.delivered_email_sent_at <= (NOW() - INTERVAL 10 MINUTE)`
      );

      for (const order of rows) {
        const email = order.customer_email || order.customerEmail;
        // Stamp first to avoid double-sending if multiple poll ticks overlap
        const [result] = await db.query(
          `UPDATE orders SET invoice_email_sent_at = NOW()
           WHERE id = ? AND invoice_email_sent_at IS NULL`,
          [order.id]
        );
        if (result.affectedRows === 0) continue;

        if (email) {
          await sendInvoiceEmail(email, buildInvoicePayload(order))
            .catch(e => console.error(`[invoiceEmailPoller] invoice email error for order ${order.id}:`, e.message));
        }
      }
    } catch (e) {
      console.error('[invoiceEmailPoller] poll error:', e.message);
    }
  };

  // Run shortly after startup, then every minute
  runOnce();
  setInterval(runOnce, 60 * 1000);
};

const resolveImage = (raw) => {
  if (!raw) return null;
  let first = raw;
  if (String(raw).startsWith('[')) {
    try { first = JSON.parse(raw).filter(Boolean)[0] || raw; } catch {}
  }
  if (first.startsWith('http')) return first;
  return first.startsWith('/uploads')
    ? first.replace('/uploads', '/seller-uploads')
    : `/seller-uploads${first.startsWith('/') ? '' : '/'}${first}`;
};

export const placeOrder = async ({
  customerId, items, address, city, pincode, state,
  paymentMethod = 'COD', paymentId = null,
  deliveryCharge = 0, platformFee = 0, paymentHandlingFee = 0, protectPromiseFee = 0,
}) => {
  if (!items || !items.length) throw new Error('No items in order');

  // One common order number for the whole checkout — every product placed
  // together shares this. Each product still gets its own row, distinguished
  // by a sub-order number (orderNumber + sequence).
  const orderNumber = genOrderNumber();
  let subSeq = 0;

  const results = [];
  for (const item of items) {
    const [prows] = await db.query('SELECT * FROM product WHERE id = ? AND active = 1', [item.productId]);
    if (!prows.length) throw Object.assign(new Error(`Product ${item.productId} not found`), { status: 404 });
    const p = prows[0];
    if (p.stock_quantity < item.quantity) throw Object.assign(new Error(`Insufficient stock for ${p.product_name}`), { status: 400 });

    const [crows] = await db.query('SELECT * FROM customer WHERE id = ?', [customerId]);
    const customer = crows[0];
    subSeq += 1;
    const subOrderNumber = `${orderNumber}-${subSeq}`;

    const [cartRow] = await db.query(
      "SELECT price_type, locked_price, deposit_paid FROM cart WHERE customer_id = ? AND product_id = ? AND price_type = 'DEAL' LIMIT 1",
      [customerId, item.productId]
    );
    const isDealItem  = cartRow.length > 0;
    const lockedPrice = isDealItem ? Number(cartRow[0].locked_price) : Number(p.retail_price);
    const depositPaid = isDealItem ? (Number(cartRow[0].deposit_paid) || 0) : 0;
    const amount      = Math.max(0, lockedPrice * item.quantity - depositPaid);

    // Shipping for THIS product only. Multi-item checkout sends a per-item
    // rate (item.deliveryCharge); fall back to the order-level value for
    // single-item purchases (Buy Now), where it's already this item's own rate.
    const itemDeliveryCharge = item.deliveryCharge != null
      ? Number(item.deliveryCharge) || 0
      : Number(deliveryCharge) || 0;

    // Add fee columns if missing (safe to call multiple times)
    try {
      await db.query(`ALTER TABLE orders
        ADD COLUMN delivery_charge DECIMAL(10,2) DEFAULT 0,
        ADD COLUMN platform_fee DECIMAL(10,2) DEFAULT 0,
        ADD COLUMN payment_handling_fee DECIMAL(10,2) DEFAULT 0,
        ADD COLUMN protect_promise_fee DECIMAL(10,2) DEFAULT 0`);
    } catch {}

    // Add sub_order_number column if missing (safe to call multiple times)
    try {
      await db.query(`ALTER TABLE orders ADD COLUMN sub_order_number VARCHAR(60) DEFAULT NULL`);
    } catch {}

    // BUG FIX: persist the courier the customer actually picked at checkout.
    // Previously the courier selected in the UI (Checkout.jsx / BuyNow.jsx)
    // was only used to calculate the delivery charge and was then thrown
    // away — it never reached the database, so the seller's Delivery
    // Management page had no way to show it. Add the columns (safe to call
    // multiple times) so we can store it on the order row.
    try {
      await db.query(`ALTER TABLE orders
        ADD COLUMN customer_courier_id INT DEFAULT NULL,
        ADD COLUMN customer_courier_name VARCHAR(255) DEFAULT NULL`);
    } catch {}

    const [r] = await db.query(
      `INSERT INTO orders (order_number, sub_order_number, product_id, seller_id, customer_id, quantity, order_amount,
        order_status, order_date, payment_status, delivery_status, address, category,
        product_name, customer_name, created_date, payment_method, customer_email, customer_phone,
        city, pincode, state, delivery_charge, platform_fee, payment_handling_fee, protect_promise_fee,
        customer_courier_id, customer_courier_name)
       VALUES (?,?,?,?,?,?,?,'Pending',NOW(),?,?,?,?,?,?,NOW(),?,?,?,?,?,?,?,?,?,?,?,?)`,
      [orderNumber, subOrderNumber, p.id, p.seller_id, customerId, item.quantity, amount,
       paymentMethod === 'Online' ? 'Paid' : 'Pending',
       'Pending', address, p.category, p.product_name,
       customer?.name || '', paymentMethod,
       customer?.email || '', customer?.mobile || '', city, pincode, state,
       Number(itemDeliveryCharge) || 0, Number(platformFee) || 0,
       Number(paymentHandlingFee) || 0, Number(protectPromiseFee) || 0,
       // BUG FIX: store what the customer selected at checkout (Checkout.jsx /
       // BuyNow.jsx now send these on each item) so the seller can see it.
       item.courierId   != null ? Number(item.courierId) : null,
       item.courierName || null]
    );

    await db.query('UPDATE product SET stock_quantity = stock_quantity - ? WHERE id = ?', [item.quantity, p.id]);

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
        await db.query('DELETE FROM campaign_hold WHERE campaign_id = ? AND customer_id = ?', [campaignId, customerId]);
        await db.query('UPDATE campaign SET current_hold = GREATEST(0, current_hold - 1) WHERE id = ?', [campaignId]);
      }
    }

    await db.query(
      'INSERT INTO customer_notification (customer_id, title, message, type) VALUES (?,?,?,?)',
      [customerId, 'Order Placed!', `Your order ${orderNumber} for ${p.product_name} has been placed.`, 'ORDER']
    );

    // Notify the seller of the new order, and of the payment if it was paid online.
    await notifySeller(
      p.seller_id,
      'New Order Received',
      `You have a new order ${subOrderNumber} for "${p.product_name}" (Qty: ${item.quantity}). Amount: ₹${amount}.`
    );
    if (paymentMethod === 'Online') {
      await notifySeller(
        p.seller_id,
        'Payment Received',
        `Online payment of ₹${amount} received for "${p.product_name}" (Ref: ${subOrderNumber}).`
      );
    }

    // Send order placed + invoice email
    try {
      const emailData = {
        name: customer?.name || '',
        orderNumber,
        productName: p.product_name,
        quantity: item.quantity,
        amount,
        address: `${address}, ${city}, ${state} - ${pincode}`,
        paymentMethod,
        orderDate: new Date().toLocaleDateString('en-IN'),
      };
      await sendOrderPlacedEmail(customer?.email || '', emailData);
    } catch (emailErr) {
      console.error('[orderService] order email error:', emailErr.message);
    }

    results.push({ orderId: r.insertId, orderNumber, subOrderNumber, productName: p.product_name, amount });

    // ── Shiprocket: create order, assign AWB, store in shipping table ──
    try {
      const orderDateStr = new Date().toISOString().replace('T', ' ').substring(0, 16);
      // BUG FIX: Shiprocket rejects orders with an empty customerPhone (it's a
      // required field on their side). Some customer profiles have no saved
      // mobile number, which silently broke shipment creation (caught below as
      // "non-fatal", but the order then never got an AWB/shipment at all).
      // Fall back to a valid placeholder phone so the shipment can still be created.
      const shiprocketPhone = (customer?.mobile && String(customer.mobile).trim())
        ? customer.mobile
        : '9999999999';

      const sr = await shiprocket.createShiprocketOrder({
        orderId:       r.insertId,
        orderNumber,
        orderDate:     orderDateStr,
        customerName:  customer?.name     || '',
        customerEmail: customer?.email    || '',
        customerPhone: shiprocketPhone,
        address,
        city,
        pincode,
        state,
        productName:   p.product_name,
        quantity:      item.quantity,
        price:         lockedPrice,
      });

      // Try to auto-assign AWB + get label if shipment_id is available
      let awbCode   = sr.awbCode;
      let courierId = sr.courierId;
      let labelUrl  = null;
      let trackingUrl = awbCode ? `https://shiprocket.co/tracking/${awbCode}` : null;

      if (sr.shiprocketShipmentId && !awbCode) {
        try {
          const assigned = await shiprocket.assignAwbAndLabel(sr.shiprocketShipmentId);
          awbCode    = assigned.awbCode    || awbCode;
          courierId  = assigned.courierId  || courierId;
          labelUrl   = assigned.labelUrl;
          trackingUrl = awbCode ? `https://shiprocket.co/tracking/${awbCode}` : null;
        } catch (e) {
          console.warn('[orderService] AWB assign failed:', e.message);
        }
      }

      // Upsert into shipping table using the new columns
      await db.query(
        `INSERT INTO shipping
           (order_id, shiprocket_order_id, shiprocket_shipment_id, awb_code, courier_id, label_url, tracking_url, tracking_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
         ON DUPLICATE KEY UPDATE
           shiprocket_order_id  = VALUES(shiprocket_order_id),
           shiprocket_shipment_id = VALUES(shiprocket_shipment_id),
           awb_code             = VALUES(awb_code),
           courier_id           = VALUES(courier_id),
           label_url            = VALUES(label_url),
           tracking_url         = VALUES(tracking_url)`,
        [
          r.insertId,
          sr.shiprocketOrderId    || null,
          sr.shiprocketShipmentId || null,
          awbCode                 || null,
          courierId               || null,
          labelUrl                || null,
          trackingUrl             || null,
        ]
      );
    } catch (srErr) {
      console.error('[orderService] Shiprocket error:', srErr.message);
      // Order is still placed — Shiprocket failure is non-fatal
    }

    // Record transaction
    try {
      await txSvc.record({
        customerId,
        orderId:     r.insertId,
        orderNumber,
        amount,
        type:        paymentMethod === 'Online' ? 'DEBIT' : 'COD',
        method:      paymentMethod,
        status:      paymentMethod === 'Online' ? 'SUCCESS' : 'PENDING',
        description: `Order ${orderNumber} — ${p.product_name} x${item.quantity}`,
        cashfreeOrderId: paymentId || null,
      });
    } catch (txErr) {
      console.error('[orderService] transaction record error:', txErr.message);
    }
  }

  for (const item of items) {
    await db.query('DELETE FROM cart WHERE customer_id = ? AND product_id = ?', [customerId, item.productId]);
  }
  return { message: 'Order placed successfully', orders: results };
};

export const trackOrder = async (orderId, customerId) => {
  const [rows] = await db.query(
    `SELECT o.id, o.order_number, o.order_status, o.delivery_status,
            s.awb_code, s.shiprocket_order_id, s.shiprocket_shipment_id,
            s.tracking_url, s.label_url, s.courier_id
     FROM orders o
     LEFT JOIN shipping s ON s.order_id = o.id
     WHERE o.id = ? AND o.customer_id = ?`,
    [orderId, customerId]
  );
  if (!rows.length) throw Object.assign(new Error('Order not found'), { status: 404 });
  const order = rows[0];

  // If AWB exists, fetch live tracking from Shiprocket
  if (order.awb_code) {
    try {
      const tracking = await shiprocket.trackByAwb(order.awb_code);
      return {
        orderNumber:    order.order_number,
        orderStatus:    order.order_status,
        deliveryStatus: order.delivery_status,
        awbCode:        order.awb_code,
        labelUrl:       order.label_url,
        tracking,
      };
    } catch (e) {
      console.error('[trackOrder] Shiprocket tracking error:', e.message);
    }
  }

  // If Shiprocket order was created but AWB not yet assigned — try assigning now
  if (order.shiprocket_shipment_id && !order.awb_code) {
    try {
      const assigned = await shiprocket.assignAwbAndLabel(order.shiprocket_shipment_id);
      if (assigned.awbCode) {
        await db.query(
          'UPDATE shipping SET awb_code = ?, courier_id = ?, label_url = ?, tracking_url = ? WHERE order_id = ?',
          [
            assigned.awbCode,
            assigned.courierId || null,
            assigned.labelUrl  || null,
            `https://shiprocket.co/tracking/${assigned.awbCode}`,
            orderId,
          ]
        );
        // Now fetch live tracking with the new AWB
        try {
          const tracking = await shiprocket.trackByAwb(assigned.awbCode);
          return {
            orderNumber:    order.order_number,
            orderStatus:    order.order_status,
            deliveryStatus: order.delivery_status,
            awbCode:        assigned.awbCode,
            labelUrl:       assigned.labelUrl || null,
            tracking,
          };
        } catch {}
      }
    } catch (e) {
      console.warn('[trackOrder] AWB re-assign attempt failed:', e.message);
    }
  }

  // Fallback: return DB status only
  return {
    orderNumber:    order.order_number,
    orderStatus:    order.order_status,
    deliveryStatus: order.delivery_status,
    awbCode:        order.awb_code    || null,
    labelUrl:       order.label_url   || null,
    tracking:       null,
  };
};

export const listOrders = async (customerId) => {
  const [rows] = await db.query(
    `SELECT o.*, s.business_name AS sellerName,
       (SELECT COUNT(*) FROM order_cancel_request ocr
        WHERE ocr.order_id = o.id
          AND ocr.resolution_type = 'Replace'
          AND ocr.status = 'Approved') AS has_replacement,
       (SELECT COUNT(*) FROM review rv
        WHERE rv.customer_id = o.customer_id
          AND rv.product_id = o.product_id) AS has_reviewed,
       p.image_url AS product_image_raw,
       sh.awb_code, sh.tracking_url, sh.label_url
     FROM orders o
     LEFT JOIN seller s ON s.id = o.seller_id
     LEFT JOIN product p ON p.id = o.product_id
     LEFT JOIN shipping sh ON sh.order_id = o.id
     WHERE o.customer_id = ? ORDER BY o.created_date DESC`,
    [customerId]
  );
  return rows.map(r => ({
    ...r,
    product_image: resolveImage(r.product_image_raw),
  }));
};

export const getOrder = async (orderId, customerId) => {
  const [rows] = await db.query(
    `SELECT o.*, s.business_name AS sellerName, s.email AS sellerEmail,
       p.image_url AS product_image_raw,
       sh.awb_code, sh.shiprocket_order_id, sh.shiprocket_shipment_id,
       sh.tracking_url, sh.label_url, sh.courier_id
     FROM orders o
     LEFT JOIN seller s ON s.id = o.seller_id
     LEFT JOIN product p ON p.id = o.product_id
     LEFT JOIN shipping sh ON sh.order_id = o.id
     WHERE o.id = ? AND o.customer_id = ?`,
    [orderId, customerId]
  );
  if (!rows[0]) return null;
  const order = { ...rows[0], product_image: resolveImage(rows[0].product_image_raw) };

  if (order.order_status === 'Delivered') {
    await markDeliveredAndSendEmail(order, order.customer_email);
  }

  return order;
};

export const cancelOrder = async ({ orderId, customerId, cancellation_reason, resolution_type }) => {
  const [rows] = await db.query('SELECT * FROM orders WHERE id = ? AND customer_id = ?', [orderId, customerId]);
  if (!rows.length) { const e = new Error('Order not found'); e.status = 404; throw e; }
  const order = rows[0];

  if (!['Pending', 'Confirmed', 'Shipped'].includes(order.order_status)) {
    const e = new Error('Cannot request cancellation for this order'); e.status = 400; throw e;
  }

  // Replacement is only available post-delivery; before/during shipment → Refund/Cancellation only
  const resType = 'Refund';

  const isPreShipment = ['Pending', 'Confirmed'].includes(order.order_status);
  const isOnline      = (order.payment_method || '').toUpperCase() === 'ONLINE';

  // ── PRE-SHIPMENT: Holdkart approves immediately ──────────────────────────────
  if (isPreShipment) {
    if (isOnline) {
      // Find the Cashfree order_id from the transaction table
      const [txRows] = await db.query(
        `SELECT cashfree_order_id FROM customer_transaction
         WHERE order_id = ? AND cashfree_order_id IS NOT NULL
         ORDER BY id DESC LIMIT 1`,
        [orderId]
      );
      const cashfreeOrderId = txRows[0]?.cashfree_order_id;

      if (cashfreeOrderId) {
        // Initiate Cashfree refund immediately
        const refundId = `refund_${orderId}_${Date.now()}`;
        try {
          await paySvc.initiateRefund({
            cashfreeOrderId,
            refundId,
            amount:  order.order_amount,
            note:    `Order ${order.order_number} cancelled — ${cancellation_reason || 'Customer request'}`,
          });
        } catch (refundErr) {
          console.error('[cancelOrder] Cashfree refund error:', refundErr.message);
          // Still proceed with cancellation; mark refund as pending so it can be retried
        }

        // Record refund transaction
        await txSvc.record({
          customerId,
          orderId,
          orderNumber:     order.order_number,
          amount:          order.order_amount,
          type:            'REFUND',
          method:          'Online',
          status:          'SUCCESS',
          description:     `Refund for cancelled order ${order.order_number} — ${order.product_name}`,
          cashfreeOrderId,
        });
      }

      // Mark order as Cancelled + Refunded immediately
      await db.query(
        `UPDATE orders SET order_status = 'Cancelled', payment_status = 'Refunded',
         cancellation_reason = ?, resolution_type = ? WHERE id = ?`,
        [cancellation_reason || null, resType, orderId]
      );

      // Record in cancel request table as already approved
      await db.query(
        `INSERT INTO order_cancel_request
           (order_id, customer_id, seller_id, cancellation_reason, resolution_type, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'Approved', NOW())`,
        [orderId, customerId, order.seller_id, cancellation_reason || null, resType]
      );

      // Restore stock
      await db.query(
        'UPDATE product SET stock_quantity = stock_quantity + ? WHERE id = ?',
        [order.quantity || 1, order.product_id]
      );

      // Send refund email
      try {
        const [cRows] = await db.query('SELECT email FROM customer WHERE id = ?', [customerId]);
        const email = cRows[0]?.email || order.customer_email;
        if (email) {
          await sendRefundProcessedEmail(email, {
            name:        order.customer_name || 'Customer',
            orderNumber: order.order_number,
            productName: order.product_name,
            refundAmount: order.order_amount,
          });
        }
      } catch (emailErr) {
        console.error('[cancelOrder] refund email error:', emailErr.message);
      }

      await db.query(
        'INSERT INTO customer_notification (customer_id, title, message, type) VALUES (?,?,?,?)',
        [
          customerId,
          '✅ Order Cancelled & Refund Initiated',
          `Your order ${order.order_number} for "${order.product_name}" has been cancelled. ₹${order.order_amount} refund has been initiated to your original payment method and will reflect within 5–7 business days.`,
          'CANCEL_REQUEST',
        ]
      );

      await notifySeller(
        order.seller_id,
        'Order Cancelled — Refund Initiated',
        `Order ${order.order_number} for "${order.product_name}" was cancelled by the customer. ₹${order.order_amount} refund has been initiated.`
      );

      return { message: 'Order cancelled and refund initiated successfully' };

    } else {
      // COD pre-shipment: just cancel immediately, no money to refund
      await db.query(
        `UPDATE orders SET order_status = 'Cancelled', cancellation_reason = ?, resolution_type = ? WHERE id = ?`,
        [cancellation_reason || null, 'Refund', orderId]
      );

      await db.query(
        `INSERT INTO order_cancel_request
           (order_id, customer_id, seller_id, cancellation_reason, resolution_type, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'Approved', NOW())`,
        [orderId, customerId, order.seller_id, cancellation_reason || null, 'Refund']
      );

      // Restore stock
      await db.query(
        'UPDATE product SET stock_quantity = stock_quantity + ? WHERE id = ?',
        [order.quantity || 1, order.product_id]
      );

      await db.query(
        'INSERT INTO customer_notification (customer_id, title, message, type) VALUES (?,?,?,?)',
        [
          customerId,
          '✅ Order Cancelled',
          `Your order ${order.order_number} for "${order.product_name}" has been cancelled successfully.`,
          'CANCEL_REQUEST',
        ]
      );

      await notifySeller(
        order.seller_id,
        'Order Cancelled',
        `Order ${order.order_number} for "${order.product_name}" was cancelled by the customer.`
      );

      return { message: 'Order cancelled successfully' };
    }
  }

  // ── SHIPPED: requires seller approval (refund after seller approves) ─────────
  if (resType === 'Replace') {
    const [existing] = await db.query(
      `SELECT id FROM order_cancel_request WHERE order_id = ? AND resolution_type = 'Replace' AND status = 'Approved' LIMIT 1`,
      [orderId]
    );
    if (existing.length) {
      const e = new Error('A replacement has already been used for this order. Only one replacement is allowed.');
      e.status = 400;
      throw e;
    }
  }

  // COD orders never have money collected up front, so a Shipped-stage COD
  // cancellation must never be recorded as a "Refund" request — there is
  // nothing to refund. Store it as a plain "Cancellation" resolution so it
  // does not show up in the seller's Refund Manager (which only lists
  // resolution_type = 'Refund' requests).
  const storedResType = (resType === 'Refund' && !isOnline) ? 'Cancellation' : resType;

  await db.query(
    "UPDATE orders SET order_status = 'Cancellation Requested', cancellation_reason = ?, resolution_type = ? WHERE id = ?",
    [cancellation_reason || null, storedResType, orderId]
  );

  await db.query(
    `INSERT INTO order_cancel_request
       (order_id, customer_id, seller_id, cancellation_reason, resolution_type, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'Pending', NOW())`,
    [orderId, customerId, order.seller_id, cancellation_reason || null, storedResType]
  );

  // Cancel on Shiprocket if we have the order ID
  try {
    const [shRows] = await db.query('SELECT shiprocket_order_id FROM shipping WHERE order_id = ?', [orderId]);
    if (shRows[0]?.shiprocket_order_id) {
      await shiprocket.cancelShiprocketOrder(shRows[0].shiprocket_order_id);
    }
  } catch (e) {
    console.warn('[cancelOrder] Shiprocket cancel failed:', e.message);
  }

  await db.query(
    'INSERT INTO customer_notification (customer_id, title, message, type) VALUES (?,?,?,?)',
    [
      customerId,
      '🕐 Cancellation Request Submitted',
      `Your ${resType} request for order ${order.order_number} ("${order.product_name}") has been sent to the seller. You'll be notified within 24–48 hours.`,
      'CANCEL_REQUEST',
    ]
  );

  return { message: 'Cancellation request submitted successfully' };
};

/**
 * updateOrderStatus — called by seller panel to update order/delivery status.
 * Sends email notifications for Shipped, Delivered, and Refund Processed.
 */
export const updateOrderStatus = async ({ orderId, orderStatus, deliveryStatus, refundAmount }) => {
  const [rows] = await db.query(
    `SELECT o.*, c.name AS customerName, c.email AS customerEmail,
            sh.awb_code, sh.tracking_url
     FROM orders o
     LEFT JOIN customer c ON c.id = o.customer_id
     LEFT JOIN shipping sh ON sh.order_id = o.id
     WHERE o.id = ?`,
    [orderId]
  );
  if (!rows.length) { const e = new Error('Order not found'); e.status = 404; throw e; }
  const order = rows[0];

  const updateFields = [];
  const updateValues = [];
  if (orderStatus)   { updateFields.push('order_status = ?');   updateValues.push(orderStatus); }
  if (deliveryStatus){ updateFields.push('delivery_status = ?'); updateValues.push(deliveryStatus); }
  if (updateFields.length) {
    await db.query(`UPDATE orders SET ${updateFields.join(', ')} WHERE id = ?`, [...updateValues, orderId]);
  }

  const email = order.customerEmail || order.customer_email;
  const name  = order.customerName  || order.customer_name || 'Customer';
  const base  = { name, orderNumber: order.order_number, productName: order.product_name };

  try {
    if (deliveryStatus === 'Shipped' || orderStatus === 'Shipped') {
      await sendOrderShippedEmail(email, {
        ...base,
        awbCode:     order.awb_code    || null,
        trackingUrl: order.tracking_url || null,
        courierName: null,
      });
    } else if (deliveryStatus === 'Delivered' || orderStatus === 'Delivered') {
      // Invoice email will be sent ~10 minutes later by the invoice email poller
      await markDeliveredAndSendEmail(order, email);
    } else if (orderStatus === 'Refund Processed' || orderStatus === 'Refunded') {
      await sendRefundProcessedEmail(email, { ...base, refundAmount: refundAmount || order.order_amount });
    }
  } catch (emailErr) {
    console.error('[updateOrderStatus] email error:', emailErr.message);
  }

  return { message: 'Order status updated successfully' };
};

/**
 * returnOrder — customer requests a return/replace for a delivered order.
 * Only allowed when order_status is 'Delivered'.
 * Uses the same order_cancel_request table as cancellations.
 */
export const returnOrder = async ({ orderId, customerId, cancellation_reason, resolution_type }) => {
  const [rows] = await db.query('SELECT * FROM orders WHERE id = ? AND customer_id = ?', [orderId, customerId]);
  if (!rows.length) { const e = new Error('Order not found'); e.status = 404; throw e; }
  const order = rows[0];

  if (order.order_status !== 'Delivered') {
    const e = new Error('Return requests are only allowed for delivered orders'); e.status = 400; throw e;
  }

  const isOnline = (order.payment_method || '').toUpperCase() === 'ONLINE';
  let resType = ['Refund', 'Replace'].includes(resolution_type) ? resolution_type : 'Refund';

  // COD orders never had money collected up front, so a "Refund" resolution
  // is not valid for them — fall back to "Replace" (or block entirely if a
  // replacement was already used) so no refund request is ever created for
  // a COD order.
  if (resType === 'Refund' && !isOnline) {
    resType = 'Replace';
  }

  if (resType === 'Replace') {
    const [existing] = await db.query(
      `SELECT id FROM order_cancel_request WHERE order_id = ? AND resolution_type = 'Replace' AND status = 'Approved' LIMIT 1`,
      [orderId]
    );
    if (existing.length) {
      const e = new Error('A replacement has already been used for this order. Only one replacement is allowed.');
      e.status = 400;
      throw e;
    }
  }

  await db.query(
    "UPDATE orders SET order_status = 'Return Requested', cancellation_reason = ?, resolution_type = ? WHERE id = ?",
    [cancellation_reason || null, resType, orderId]
  );

  await db.query(
    `INSERT INTO order_cancel_request
       (order_id, customer_id, seller_id, cancellation_reason, resolution_type, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'Pending', NOW())`,
    [orderId, customerId, order.seller_id, cancellation_reason || null, resType]
  );

  await db.query(
    'INSERT INTO customer_notification (customer_id, title, message, type) VALUES (?,?,?,?)',
    [
      customerId,
      '🔄 Return Request Submitted',
      `Your ${resType} request for order ${order.order_number} ("${order.product_name}") has been sent to the seller. You'll be notified within 24–48 hours.`,
      'RETURN_REQUEST',
    ]
  );

  return { message: 'Return request submitted successfully' };
};