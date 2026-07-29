import db from '../config/db.js';
import * as txSvc from './transactionService.js';
import * as shiprocket from './shiprocketService.js';
import * as paySvc from './paymentService.js';
import * as ledger from './ledgerService.js';
import { sendOrderPlacedEmail, sendInvoiceEmail, sendOrderShippedEmail, sendOrderDeliveredEmail, sendRefundProcessedEmail } from '../config/email.js';

const genOrderNumber = () => 'HK' + Date.now();

// BUG FIX: product.stock_quantity / reserved_stock are meant to be a cached
// SUM of all product_variant rows (per productVariantService's own
// syncProductStockFromVariants on the seller backend) — every screen that
// shows "in stock" for a variant product reads these two product-level
// columns rather than summing variants itself. This order flow only ever
// updated product_variant.stock_quantity directly and never resynced the
// parent product row, so after any variant order/cancel/return the
// product-level total silently drifted out of sync with reality (stale,
// usually too high) until something else happened to trigger a resync.
const syncProductStockFromVariants = async (productId) => {
  const [[totals]] = await db.query(
    `SELECT COALESCE(SUM(stock_quantity),0) AS total,
            COALESCE(SUM(reserved_stock),0) AS reserved
     FROM product_variant WHERE product_id = ?`,
    [productId]
  );
  await db.query(
    `UPDATE product SET stock_quantity = ?, reserved_stock = ? WHERE id = ?`,
    [totals.total, totals.reserved, productId]
  );
};

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
      ADD COLUMN IF NOT EXISTS delivered_email_sent_at TIMESTAMP NULL,
      ADD COLUMN IF NOT EXISTS invoice_email_sent_at TIMESTAMP NULL`);
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
        `SELECT o.*, s.business_name AS "sellerName", s.email AS "sellerEmail", c.email AS "customerEmail", c.name AS "customerName"
         FROM orders o
         LEFT JOIN seller s ON s.id = o.seller_id
         LEFT JOIN customer c ON c.id = o.customer_id
         WHERE o.delivered_email_sent_at IS NOT NULL
           AND o.invoice_email_sent_at IS NULL
           AND o.delivered_email_sent_at <= (NOW() - INTERVAL '10 minutes')`
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

// ── One-time migration ──────────────────────────────────────────────────────
// `orders` never had a way to record which variant (colour/size) a customer
// checked out with — only `product_id` was stored. So when a completed group
// deal (tied to e.g. "Green / L" in the cart) was checked out, the variant
// was silently dropped and the order — and every screen reading it — fell
// back to the product's default photo/variant (e.g. Blue). This adds a
// variant_id column (0 = no variant, same convention as `cart` and
// `campaign_hold`) so orders keep the exact colour/size the customer bought.
let orderVariantColumnReady = null;
const ensureOrderVariantColumn = async () => {
  if (orderVariantColumnReady) return orderVariantColumnReady;
  orderVariantColumnReady = (async () => {
    try {
      const [cols] = await db.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'variant_id'`
      );
      if (!cols.length) {
        await db.query(`ALTER TABLE orders ADD COLUMN variant_id INT NOT NULL DEFAULT 0 AFTER product_id`);
      }
    } catch (e) {
      console.error('orders variant_id migration check failed:', e.message);
    }
  })();
  return orderVariantColumnReady;
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
  await ensureOrderVariantColumn();

  // Platform fee is admin-configurable now (Commission Settings screen),
  // never trusted from the client.
  const [feeSettingRows] = await db.query(
    `SELECT value FROM platform_settings WHERE key = 'platform_fee'`
  );
  platformFee = feeSettingRows.length ? Number(feeSettingRows[0].value) : 5;

  // SECURITY FIX (critical payment bypass): this previously marked any order
  // with paymentMethod === 'Online' as payment_status = 'Paid' immediately at
  // creation, purely on the client's say-so — no payment had to actually
  // happen. Anyone calling this endpoint directly (skipping the Cashfree
  // checkout UI entirely) got instant "Paid" orders for free. The frontend
  // already does the right thing (verifies with Cashfree, then sends the
  // verified paymentId here — see Checkout.jsx), but the server never
  // checked it. Now: for an "Online" order, payment is only considered
  // verified if paymentId is supplied AND a fresh server-to-server check
  // with Cashfree confirms that order is actually PAID. Anything else
  // (missing paymentId, failed re-verification) falls back to 'Pending',
  // exactly like an unpaid COD order — never silently 'Paid'.
  let verifiedPaid = false;
  if (paymentMethod === 'Online' && paymentId) {
    try {
      verifiedPaid = await paySvc.verifyPayment({ orderId: paymentId });
    } catch (e) {
      console.error('[placeOrder] payment re-verification failed:', e.message);
      verifiedPaid = false;
    }
  }
  const resolvedPaymentStatus = paymentMethod === 'Online'
    ? (verifiedPaid ? 'Paid' : 'Pending')
    : 'Pending';

  // One common order number for the whole checkout — every product placed
  // together shares this. Each product still gets its own row, distinguished
  // by a sub-order number (orderNumber + sequence).
  const orderNumber = genOrderNumber();
  let subSeq = 0;

  const results = [];
  for (const item of items) {
    const [prows] = await db.query('SELECT * FROM product WHERE id = ? AND active = true', [item.productId]);
    if (!prows.length) throw Object.assign(new Error(`Product ${item.productId} not found`), { status: 404 });
    const p = prows[0];

    // Match the exact variant the customer is checking out (0 = no variant / base
    // product), so a product with several DEAL rows in the cart — one per variant —
    // resolves to the correct price/deposit instead of an arbitrary "LIMIT 1" row.
    const vId = item.variantId ? Number(item.variantId) : 0;

    // BUG FIX: when the item is a specific variant (colour/size), stock must be
    // checked/decremented against that variant's own stock_quantity, not the
    // parent product's. Previously we always checked/decremented
    // product.stock_quantity, so buying a variant never reduced that variant's
    // available quantity — it silently drained the (often unused) base
    // product stock instead, letting a sold-out variant keep showing as
    // in-stock.
    let variantRow = null;
    if (vId) {
      const [vrows] = await db.query('SELECT * FROM product_variant WHERE id = ? AND product_id = ?', [vId, p.id]);
      if (!vrows.length) throw Object.assign(new Error(`Variant not found for ${p.product_name}`), { status: 404 });
      variantRow = vrows[0];
      if (variantRow.stock_quantity < item.quantity) throw Object.assign(new Error(`Insufficient stock for ${p.product_name}`), { status: 400 });
    } else {
      if (p.stock_quantity < item.quantity) throw Object.assign(new Error(`Insufficient stock for ${p.product_name}`), { status: 400 });
    }

    const [crows] = await db.query('SELECT * FROM customer WHERE id = ?', [customerId]);
    const customer = crows[0];
    subSeq += 1;
    const subOrderNumber = `${orderNumber}-${subSeq}`;
    // FIX: platform fee is charged once per checkout (Cashfree only collects
    // it once), not once per item — only the first row in a multi-item cart
    // carries it, so SUM(platform_fee) across orders can't overcount.
    const itemPlatformFee = subSeq === 1 ? platformFee : 0;

    // BUG FIX: this used to look up the cart row by
    // `customer_id + product_id + variant_id + price_type = 'DEAL'`, with no
    // way to tell which cart row THIS checkout item actually came from. If a
    // customer bought the same product both as a normal item AND as a
    // campaign deal in one checkout (two separate cart rows, same
    // product/variant), that query matched the DEAL row on *every* iteration
    // — so the normal item was also priced at the deal's hold price and had
    // the deal's whole deposit wrongly subtracted from it, while the deal
    // item still worked correctly. Net effect: total revenue for the
    // checkout came out short (e.g. ₹120 instead of the correct ₹165 for a
    // ₹65 normal order + a 2-qty ₹50 deal with ₹30 deposit already paid).
    //
    // FIX: the frontend now sends item.cartId — the exact cart row this line
    // was built from (see Checkout.jsx placeCOD/placeOnline). Look that row
    // up directly by id instead of guessing by product+variant, so a normal
    // item and a deal item for the same product can never be confused.
    let cartRow = [];
    if (item.cartId != null) {
      [cartRow] = await db.query(
        "SELECT price_type, locked_price, deposit_paid FROM cart WHERE id = ? AND customer_id = ?",
        [item.cartId, customerId]
      );
    } else {
      // Fallback for any caller that hasn't been updated to send cartId yet.
      // Kept narrow (still requires price_type = 'DEAL') to preserve old
      // behaviour for single-item / non-mixed checkouts.
      [cartRow] = await db.query(
        "SELECT price_type, locked_price, deposit_paid FROM cart WHERE customer_id = ? AND product_id = ? AND variant_id = ? AND price_type = 'DEAL' LIMIT 1",
        [customerId, item.productId, vId]
      );
    }
    const isDealItem  = cartRow.length > 0 && cartRow[0].price_type === 'DEAL';
    // BUG FIX: for a regular (non-deal) purchase of a specific variant, the
    // variant's own price_override must win over the base product's
    // retail_price. Previously this always used p.retail_price regardless of
    // variant, so e.g. a ₹1000 "Blue / M" variant on a ₹900 base product was
    // silently charged at ₹900 — undercharging (or overcharging, depending on
    // the variant) on every regular variant order.
    const regularPrice = (variantRow && variantRow.price_override != null)
      ? Number(variantRow.price_override)
      : Number(p.retail_price);
    const lockedPrice = isDealItem ? Number(cartRow[0].locked_price) : regularPrice;
    const depositPaid = isDealItem ? (Number(cartRow[0].deposit_paid) || 0) : 0;
    const amount      = Math.max(0, lockedPrice * item.quantity - depositPaid);

    // FIX (§3.1 / §3.3): keep the real charge breakdown, not just the netted
    // total. advanceAmount is whatever was already paid up front (deal
    // deposit); balanceAmount is what's due on this order row itself. Every
    // refund/receipt downstream should read these instead of re-deriving
    // them from order_amount, which has already had the deposit netted out.
    const advanceAmount = depositPaid;
    const balanceAmount = amount;

    // Shipping for THIS product only. Multi-item checkout sends a per-item
    // rate (item.deliveryCharge); fall back to the order-level value for
    // single-item purchases (Buy Now), where it's already this item's own rate.
    const itemDeliveryCharge = item.deliveryCharge != null
      ? Number(item.deliveryCharge) || 0
      : Number(deliveryCharge) || 0;

    // FIX: itemDeliveryCharge already includes the platform's delivery
    // commission markup (applied in getAvailableCouriers). Never trust a
    // client-supplied "actual cost" — recompute it server-side by reversing
    // today's markup rate, the same principle used for platform_fee.
    let deliveryCommissionPct = 5;
    try {
      const [settingRows] = await db.query(
        `SELECT value FROM platform_settings WHERE key = 'delivery_commission_pct'`
      );
      if (settingRows.length) deliveryCommissionPct = Number(settingRows[0].value) || 0;
    } catch {}
    const shiprocketActualCost = Math.round(
      (itemDeliveryCharge / (1 + deliveryCommissionPct / 100)) * 100
    ) / 100;

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

    // Ensure advance/balance/total columns exist (safe to call multiple times) —
    // see migrations/001_unified_ledger.sql / 002_total_amount.sql for the
    // canonical versions.
    try {
      await db.query(`ALTER TABLE orders
        ADD COLUMN advance_amount NUMERIC(10,2) DEFAULT 0,
        ADD COLUMN balance_amount NUMERIC(10,2) DEFAULT 0,
        ADD COLUMN total_amount NUMERIC(10,2) DEFAULT 0`);
    } catch {}

    try {
      await db.query(`ALTER TABLE orders ADD COLUMN shiprocket_actual_cost NUMERIC(10,2) DEFAULT 0`);
    } catch {}

    // FIX: total_amount is what the customer actually paid — product +
    // delivery + platform fee + payment handling fee + protect promise fee.
    // order_amount stays PRODUCT PRICE ONLY (it's the base seller commission
    // is calculated on — see holdkart-seller-node's calcCommission). Every
    // admin GMV/order-total/customer-LTV read should use total_amount, not
    // order_amount, or it silently drops delivery + platform fee from every
    // number it shows (this was the root cause of admin dashboards showing
    // ₹65 instead of ₹155.85 for a ₹65 product + ₹80.85 delivery + ₹10
    // platform fee order).
    const totalAmount = Math.round((
      advanceAmount + balanceAmount
      + (Number(itemDeliveryCharge) || 0)
      + (Number(itemPlatformFee) || 0)
      + (Number(paymentHandlingFee) || 0)
      + (Number(protectPromiseFee) || 0)
    ) * 100) / 100;

    const [r] = await db.query(
      `INSERT INTO orders (order_number, sub_order_number, product_id, variant_id, seller_id, customer_id, quantity, order_amount,
        order_status, order_date, payment_status, delivery_status, address, category,
        product_name, customer_name, created_date, payment_method, customer_email, customer_phone,
        city, pincode, state, delivery_charge, platform_fee, payment_handling_fee, protect_promise_fee,
        customer_courier_id, customer_courier_name, advance_amount, balance_amount, total_amount, shiprocket_actual_cost)
       VALUES (?,?,?,?,?,?,?,?,'Pending',NOW(),?,?,?,?,?,?,NOW(),?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [orderNumber, subOrderNumber, p.id, vId, p.seller_id, customerId, item.quantity, amount,
       resolvedPaymentStatus,
       'Pending', address, p.category, p.product_name,
       customer?.name || '', paymentMethod,
       customer?.email || '', customer?.mobile || '', city, pincode, state,
       Number(itemDeliveryCharge) || 0, Number(itemPlatformFee) || 0,
       Number(paymentHandlingFee) || 0, Number(protectPromiseFee) || 0,
       // BUG FIX: store what the customer selected at checkout (Checkout.jsx /
       // BuyNow.jsx now send these on each item) so the seller can see it.
       item.courierId   != null ? Number(item.courierId) : null,
       item.courierName || null,
       advanceAmount, balanceAmount, totalAmount, shiprocketActualCost]
    );

    // FIX (§1 / §3.1): append to the unified ledger instead of leaving this
    // charge only recorded in `orders`. This is what admin Finance reports
    // and refund itemization now read from — a single source of truth
    // shared across all three backends.
    try {
      if (advanceAmount > 0) {
        // FIX: the deposit was already appended to the ledger at
        // campaign-join time (see campaignService.js joinCampaign /
        // startOrJoinCampaign / addToDeal) — that's the moment the money was
        // actually collected. Writing a second PAYMENT entry for the same
        // amount here would double-count it in GMV. Instead, just link the
        // existing deposit ledger row(s) to this order now that it has one,
        // so admin can trace deposit -> converted order.
        await db.query(
          `UPDATE ledger_entry SET order_id = ?, order_number = ?
           WHERE id = (
             SELECT id FROM ledger_entry
             WHERE customer_id = ? AND entry_type = 'PAYMENT' AND method = 'DEAL_DEPOSIT'
               AND order_id IS NULL AND status = 'SUCCESS' AND amount = ?
               AND description LIKE ?
             ORDER BY id DESC LIMIT 1
           )`,
          [r.insertId, subOrderNumber, customerId, advanceAmount, `%${p.product_name}%`]
        ).catch(() => {});
      }
      if (balanceAmount > 0 || paymentMethod !== 'COD') {
        await ledger.appendLedgerEntry({
          entryType: 'PAYMENT', direction: 'CREDIT', amount: balanceAmount,
          orderId: r.insertId, orderNumber: subOrderNumber, customerId, sellerId: p.seller_id,
          method: paymentMethod, status: resolvedPaymentStatus === 'Paid' ? 'SUCCESS' : 'PENDING',
          referenceTable: 'orders', referenceId: r.insertId,
          description: `Order payment for ${p.product_name} (${subOrderNumber})`,
        });
      }
    } catch (ledgerErr) {
      console.error('[placeOrder] ledger append failed (non-fatal):', ledgerErr.message);
    }

    if (vId) {
      await db.query('UPDATE product_variant SET stock_quantity = stock_quantity - ? WHERE id = ?', [item.quantity, vId]);
      await syncProductStockFromVariants(p.id);
    } else {
      await db.query('UPDATE product SET stock_quantity = stock_quantity - ? WHERE id = ?', [item.quantity, p.id]);
    }

    // Match the campaign for the exact variant being checked out — a product can
    // have several variant-scoped campaigns active at once, so grabbing "any"
    // active campaign here could clear/decrement the wrong one.
    const [activeCampaigns] = await db.query(
      "SELECT id, variant_id FROM campaign WHERE product_id = ? AND status = 'ACTIVE'",
      [p.id]
    );
    const matchedCampaign = activeCampaigns.find(c => vId && Number(c.variant_id) === vId)
      || activeCampaigns.find(c => !c.variant_id);
    if (matchedCampaign) {
      const campaignId = matchedCampaign.id;
      const [holdRow] = await db.query(
        'SELECT id FROM campaign_hold WHERE campaign_id = ? AND customer_id = ? AND variant_id = ?',
        [campaignId, customerId, vId]
      );
      if (holdRow.length) {
        await db.query('DELETE FROM campaign_hold WHERE campaign_id = ? AND customer_id = ? AND variant_id = ?', [campaignId, customerId, vId]);
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

      // Compute real parcel weight/dims from the product's specs (set by the
      // seller / admin) rather than relying on shiprocketService's 0.5kg /
      // 10cm defaults. Multiply weight by quantity since this is the total
      // weight for this line's shipment.
      let productSpecs = p.specs;
      if (typeof productSpecs === 'string') {
        try { productSpecs = JSON.parse(productSpecs); } catch (_) { productSpecs = null; }
      }
      const unitWeight = parseFloat(productSpecs?.ship_weight);
      const shipmentWeight = (!Number.isNaN(unitWeight) && unitWeight > 0)
        ? Math.round(unitWeight * item.quantity * 1000) / 1000
        : 0.5; // legacy fallback only — new products require ship_weight at creation
      const shipLength = parseFloat(productSpecs?.ship_length) || 10;
      const shipWidth   = parseFloat(productSpecs?.ship_width)  || 10;
      const shipHeight  = parseFloat(productSpecs?.ship_height) || 10;

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
        weight:        shipmentWeight,
        length:        shipLength,
        breadth:       shipWidth,
        height:        shipHeight,
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
         ON CONFLICT (order_id) DO UPDATE SET
           shiprocket_order_id    = EXCLUDED.shiprocket_order_id,
           shiprocket_shipment_id = EXCLUDED.shiprocket_shipment_id,
           awb_code               = EXCLUDED.awb_code,
           courier_id             = EXCLUDED.courier_id,
           label_url              = EXCLUDED.label_url,
           tracking_url           = EXCLUDED.tracking_url`,
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

      // FIX (§3.4): capture the courier's quoted rate at booking time so it
      // can be reconciled against Shiprocket's actual monthly invoice later
      // (see admin-node financeService / a future reconciliation screen).
      // Without this, there was no record at all of what any given shipment
      // was quoted to cost, so Shiprocket's invoice had nothing to check
      // against — same idea as reconciling a payment gateway's settlement
      // report against your own records.
      try {
        await db.query(
          `INSERT INTO courier_cost (order_id, shiprocket_order_id, quoted_rate, invoice_month)
           VALUES (?, ?, ?, TO_CHAR(NOW(), 'YYYY-MM'))`,
          [r.insertId, sr.shiprocketOrderId || null, Number(itemDeliveryCharge) || 0]
        );
      } catch (courierCostErr) {
        console.error('[placeOrder] courier_cost insert failed (non-fatal):', courierCostErr.message);
      }
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
  await ensureOrderVariantColumn();
  const [rows] = await db.query(
    `SELECT o.*, s.business_name AS "sellerName",
       (SELECT COUNT(*) FROM order_cancel_request ocr
        WHERE ocr.order_id = o.id
          AND ocr.resolution_type = 'Replace'
          AND ocr.status = 'Approved') AS has_replacement,
       (SELECT COUNT(*) FROM review rv
        WHERE rv.customer_id = o.customer_id
          AND rv.product_id = o.product_id) AS has_reviewed,
       p.image_url AS product_image_raw,
       pv.color AS variant_color, pv.size AS variant_size,
       (SELECT vi.image_url FROM product_variant_image vi
        WHERE vi.variant_id = pv.id ORDER BY vi.sort_order, vi.id LIMIT 1) AS variant_image_raw,
       sh.awb_code, sh.tracking_url, sh.label_url
     FROM orders o
     LEFT JOIN seller s ON s.id = o.seller_id
     LEFT JOIN product p ON p.id = o.product_id
     LEFT JOIN product_variant pv ON pv.id = o.variant_id AND pv.product_id = o.product_id
     LEFT JOIN shipping sh ON sh.order_id = o.id
     WHERE o.customer_id = ? ORDER BY o.created_date DESC`,
    [customerId]
  );
  // The exact colour/size the customer checked out with (o.variant_id) takes
  // priority over the product's default photo — a product can be ordered in
  // several different variants, each with its own image.
  return rows.map(r => ({
    ...r,
    product_image: resolveImage(r.variant_image_raw) || resolveImage(r.product_image_raw),
  }));
};

export const getOrder = async (orderId, customerId) => {
  await ensureOrderVariantColumn();
  const [rows] = await db.query(
    `SELECT o.*, s.business_name AS "sellerName", s.email AS "sellerEmail",
       p.image_url AS product_image_raw,
       pv.color AS variant_color, pv.size AS variant_size,
       (SELECT vi.image_url FROM product_variant_image vi
        WHERE vi.variant_id = pv.id ORDER BY vi.sort_order, vi.id LIMIT 1) AS variant_image_raw,
       sh.awb_code, sh.shiprocket_order_id, sh.shiprocket_shipment_id,
       sh.tracking_url, sh.label_url, sh.courier_id
     FROM orders o
     LEFT JOIN seller s ON s.id = o.seller_id
     LEFT JOIN product p ON p.id = o.product_id
     LEFT JOIN product_variant pv ON pv.id = o.variant_id AND pv.product_id = o.product_id
     LEFT JOIN shipping sh ON sh.order_id = o.id
     WHERE o.id = ? AND o.customer_id = ?`,
    [orderId, customerId]
  );
  if (!rows[0]) return null;
  const order = {
    ...rows[0],
    product_image: resolveImage(rows[0].variant_image_raw) || resolveImage(rows[0].product_image_raw),
  };

  if (order.order_status === 'Delivered') {
    await markDeliveredAndSendEmail(order, order.customer_email);
  }

  return order;
};

// FIX (§3.3): refunds must mirror the original charge breakdown exactly,
// itemized — the same way Amazon/Flipkart refunds do — instead of just
// refunding the netted order_amount (which silently under-refunds by the
// delivery charge on every cancellation). Refundable = product amount +
// advance/deposit already paid + delivery charge. platform_fee and
// payment_handling_fee are the non-refundable service/gateway fees.
// protect_promise_fee is a protection premium and is also non-refundable.
const computeItemizedRefund = (order) => {
  const advance      = Number(order.advance_amount) || 0;
  const balance      = Number(order.balance_amount) || Number(order.order_amount) || 0;
  const deliveryChg  = Number(order.delivery_charge) || 0;
  const nonRefundable = (Number(order.platform_fee) || 0)
                       + (Number(order.payment_handling_fee) || 0)
                       + (Number(order.protect_promise_fee) || 0);
  const refundable = Math.max(0, advance + balance + deliveryChg - nonRefundable);
  return { advance, balance, deliveryChg, nonRefundable, refundable };
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
        const { refundable } = computeItemizedRefund(order);
        // Initiate Cashfree refund immediately
        const refundId = `refund_${orderId}_${Date.now()}`;
        try {
          await paySvc.initiateRefund({
            cashfreeOrderId,
            refundId,
            amount:  refundable,
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
          amount:          refundable,
          type:            'REFUND',
          method:          'Online',
          status:          'SUCCESS',
          description:     `Refund for cancelled order ${order.order_number} — ${order.product_name}`,
          cashfreeOrderId,
        });

        // FIX (§1): append the itemized refund to the unified ledger.
        try {
          await ledger.appendLedgerEntry({
            entryType: 'REFUND', direction: 'DEBIT', amount: refundable,
            orderId, orderNumber: order.order_number, customerId, sellerId: order.seller_id,
            method: 'Online', referenceTable: 'order_cancel_request', referenceId: orderId,
            description: `Itemized refund for cancelled order ${order.order_number} (product+advance+delivery − non-refundable fees)`,
          });
        } catch (ledgerErr) {
          console.error('[cancelOrder] ledger append failed (non-fatal):', ledgerErr.message);
        }
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

      // Restore stock (BUG FIX: restore to the specific variant if this
      // order was for one, instead of always crediting the base product)
      if (order.variant_id) {
        await db.query(
          'UPDATE product_variant SET stock_quantity = stock_quantity + ? WHERE id = ?',
          [order.quantity || 1, order.variant_id]
        );
        await syncProductStockFromVariants(order.product_id);
      } else {
        await db.query(
          'UPDATE product SET stock_quantity = stock_quantity + ? WHERE id = ?',
          [order.quantity || 1, order.product_id]
        );
      }

      // Send refund email
      try {
        const [cRows] = await db.query('SELECT email FROM customer WHERE id = ?', [customerId]);
        const email = cRows[0]?.email || order.customer_email;
        if (email) {
          await sendRefundProcessedEmail(email, {
            name:        order.customer_name || 'Customer',
            orderNumber: order.order_number,
            productName: order.product_name,
            refundAmount: computeItemizedRefund(order).refundable,
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
          `Your order ${order.order_number} for "${order.product_name}" has been cancelled. ₹${computeItemizedRefund(order).refundable} refund has been initiated to your original payment method and will reflect within 5–7 business days.`,
          'CANCEL_REQUEST',
        ]
      );

      await notifySeller(
        order.seller_id,
        'Order Cancelled — Refund Initiated',
        `Order ${order.order_number} for "${order.product_name}" was cancelled by the customer. ₹${computeItemizedRefund(order).refundable} refund has been initiated.`
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

      // Restore stock (BUG FIX: restore to the specific variant if this
      // order was for one, instead of always crediting the base product)
      if (order.variant_id) {
        await db.query(
          'UPDATE product_variant SET stock_quantity = stock_quantity + ? WHERE id = ?',
          [order.quantity || 1, order.variant_id]
        );
        await syncProductStockFromVariants(order.product_id);
      } else {
        await db.query(
          'UPDATE product SET stock_quantity = stock_quantity + ? WHERE id = ?',
          [order.quantity || 1, order.product_id]
        );
      }

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

  // FIX (§2 — wallet-bucket fix): if this order's seller credit is still in
  // the Pending bucket (hold period not yet cleared), a return filed now must
  // move it to Reserved, not leave it sitting in Pending where the hold-period
  // job would release it into Available out from under an active dispute.
  // If the hold already cleared (funds are in Available), we leave it there —
  // reserving already-withdrawable money on a mere request (before seller/
  // admin approval) would be too aggressive; the seller-side approval flow
  // handles clawback from Available if the return is approved after that point.
  if (storedResType === 'Refund') {
    try {
      const [pendingLedger] = await db.query(
        `SELECT COALESCE(SUM(amount),0) AS pending_credit FROM ledger_entry
         WHERE order_id = ? AND entry_type = 'SELLER_CREDIT' AND status = 'PENDING'`,
        [orderId]
      );
      const heldAmount = Number(pendingLedger[0]?.pending_credit) || 0;
      if (heldAmount > 0) {
        await db.query(
          `UPDATE seller_wallet
           SET pending_amount  = GREATEST(0, pending_amount - ?),
               reserved_amount = reserved_amount + ?
           WHERE seller_id = ?`,
          [heldAmount, heldAmount, order.seller_id]
        );
        await db.query(
          `UPDATE ledger_entry SET status = 'RESERVED'
           WHERE order_id = ? AND entry_type = 'SELLER_CREDIT' AND status = 'PENDING'`,
          [orderId]
        );
      }
    } catch (reserveErr) {
      console.error('[cancelOrder] wallet reservation failed (non-fatal):', reserveErr.message);
    }
  }

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
/**
 * updateOrderStatus — called by seller panel to update order/delivery status.
 * SECURITY FIX: this had zero ownership check (`WHERE o.id = ?` only) while
 * living on the customer-authenticated router — any logged-in customer
 * could change the order_status/delivery_status/refundAmount of ANY order
 * in the system, not just their own, just by hitting this endpoint with a
 * different orderId. Nothing in the current frontend actually calls this
 * route, but it was still live and exploitable, so it's now scoped to the
 * calling customer's own orders.
 */
export const updateOrderStatus = async ({ orderId, orderStatus, deliveryStatus, refundAmount, customerId }) => {
  const [rows] = await db.query(
    `SELECT o.*, c.name AS "customerName", c.email AS "customerEmail",
            sh.awb_code, sh.tracking_url
     FROM orders o
     LEFT JOIN customer c ON c.id = o.customer_id
     LEFT JOIN shipping sh ON sh.order_id = o.id
     WHERE o.id = ?`,
    [orderId]
  );
  if (!rows.length) { const e = new Error('Order not found'); e.status = 404; throw e; }
  const order = rows[0];

  if (customerId != null && String(order.customer_id) !== String(customerId)) {
    const e = new Error('You do not have permission to update this order');
    e.status = 403;
    throw e;
  }

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