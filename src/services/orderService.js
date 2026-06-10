import db from '../config/db.js';
import * as txSvc from './transactionService.js';
import * as shiprocket from './shiprocketService.js';

const genOrderNumber = () => 'HK' + Date.now();

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

  const results = [];
  for (const item of items) {
    const [prows] = await db.query('SELECT * FROM product WHERE id = ? AND active = 1', [item.productId]);
    if (!prows.length) throw Object.assign(new Error(`Product ${item.productId} not found`), { status: 404 });
    const p = prows[0];
    if (p.stock_quantity < item.quantity) throw Object.assign(new Error(`Insufficient stock for ${p.product_name}`), { status: 400 });

    const [crows] = await db.query('SELECT * FROM customer WHERE id = ?', [customerId]);
    const customer = crows[0];
    const orderNumber = genOrderNumber();

    const [cartRow] = await db.query(
      "SELECT price_type, locked_price, deposit_paid FROM cart WHERE customer_id = ? AND product_id = ? AND price_type = 'DEAL' LIMIT 1",
      [customerId, item.productId]
    );
    const isDealItem  = cartRow.length > 0;
    const lockedPrice = isDealItem ? Number(cartRow[0].locked_price) : Number(p.retail_price);
    const depositPaid = isDealItem ? (Number(cartRow[0].deposit_paid) || 0) : 0;
    const amount      = Math.max(0, lockedPrice * item.quantity - depositPaid);

    // Add fee columns if missing (safe to call multiple times)
    try {
      await db.query(`ALTER TABLE orders
        ADD COLUMN delivery_charge DECIMAL(10,2) DEFAULT 0,
        ADD COLUMN platform_fee DECIMAL(10,2) DEFAULT 0,
        ADD COLUMN payment_handling_fee DECIMAL(10,2) DEFAULT 0,
        ADD COLUMN protect_promise_fee DECIMAL(10,2) DEFAULT 0`);
    } catch {}

    const [r] = await db.query(
      `INSERT INTO orders (order_number, product_id, seller_id, customer_id, quantity, order_amount,
        order_status, order_date, payment_status, delivery_status, address, category,
        product_name, customer_name, created_date, payment_method, customer_email, customer_phone,
        city, pincode, state, delivery_charge, platform_fee, payment_handling_fee, protect_promise_fee)
       VALUES (?,?,?,?,?,?,'Pending',NOW(),?,?,?,?,?,?,NOW(),?,?,?,?,?,?,?,?,?,?)`,
      [orderNumber, p.id, p.seller_id, customerId, item.quantity, amount,
       paymentMethod === 'Online' ? 'Paid' : 'Pending',
       'Pending', address, p.category, p.product_name,
       customer?.name || '', paymentMethod,
       customer?.email || '', customer?.mobile || '', city, pincode, state,
       Number(deliveryCharge) || 0, Number(platformFee) || 0,
       Number(paymentHandlingFee) || 0, Number(protectPromiseFee) || 0]
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

    results.push({ orderId: r.insertId, orderNumber, productName: p.product_name, amount });

    // ── Shiprocket: create order, assign AWB, store in shipping table ──
    try {
      const orderDateStr = new Date().toISOString().replace('T', ' ').substring(0, 16);
      const sr = await shiprocket.createShiprocketOrder({
        orderId:       r.insertId,
        orderNumber,
        orderDate:     orderDateStr,
        customerName:  customer?.name     || '',
        customerEmail: customer?.email    || '',
        customerPhone: customer?.mobile   || '',
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
  return { ...rows[0], product_image: resolveImage(rows[0].product_image_raw) };
};

export const cancelOrder = async ({ orderId, customerId, cancellation_reason, resolution_type }) => {
  const [rows] = await db.query('SELECT * FROM orders WHERE id = ? AND customer_id = ?', [orderId, customerId]);
  if (!rows.length) { const e = new Error('Order not found'); e.status = 404; throw e; }
  const order = rows[0];

  if (!['Pending', 'Confirmed'].includes(order.order_status)) {
    const e = new Error('Cannot request cancellation for this order'); e.status = 400; throw e;
  }

  const resType = ['Refund', 'Replace'].includes(resolution_type) ? resolution_type : 'Refund';

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
    "UPDATE orders SET order_status = 'Cancellation Requested', cancellation_reason = ?, resolution_type = ? WHERE id = ?",
    [cancellation_reason || null, resType, orderId]
  );

  await db.query(
    `INSERT INTO order_cancel_request
       (order_id, customer_id, seller_id, cancellation_reason, resolution_type, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'Pending', NOW())`,
    [orderId, customerId, order.seller_id, cancellation_reason || null, resType]
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