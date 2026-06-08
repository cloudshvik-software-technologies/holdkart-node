import db from '../config/db.js';
import * as svc from '../services/paymentService.js';

/**
 * POST /api/customer/payment/create-order
 * Body: { amount, currency?, receipt?, customerInfo? }
 */
export const createOrder = async (req, res) => {
  try {
    const result = await svc.createOrder(req.body);
    res.json(result);
  } catch (e) {
    console.error('[Payment] createOrder error:', e.message);
    res.status(500).json({ message: e.message });
  }
};

/**
 * POST /api/customer/payment/verify
 * Body: { orderId, amount?, productName? }
 */
export const verifyPayment = async (req, res) => {
  try {
    const ok = await svc.verifyPayment(req.body);
    if (!ok) {
      // Send payment failure notification
      if (req.customer?.id) {
        await db.query(
          'INSERT INTO customer_notification (customer_id, title, message, type) VALUES (?,?,?,?)',
          [
            req.customer.id,
            '⚠️ Payment Failed',
            `Your payment could not be verified. No amount has been charged. Please try again or use Cash on Delivery.`,
            'PAYMENT',
          ]
        ).catch(() => {});
      }
      return res.status(400).json({ message: 'Payment verification failed – order not paid' });
    }

    // Send payment success notification
    if (req.customer?.id) {
      const amt = req.body.amount ? `₹${Number(req.body.amount).toLocaleString('en-IN')}` : '';
      await db.query(
        'INSERT INTO customer_notification (customer_id, title, message, type) VALUES (?,?,?,?)',
        [
          req.customer.id,
          '✅ Payment Successful',
          `Your payment${amt ? ' of ' + amt : ''} was successful. Your order is being processed.`,
          'PAYMENT',
        ]
      ).catch(() => {});
    }

    res.json({ message: 'Payment verified', success: true });
  } catch (e) {
    console.error('[Payment] verifyPayment error:', e.message);
    res.status(500).json({ message: e.message });
  }
};

/**
 * POST /api/customer/payment/webhook
 * Cashfree sends payment events here.
 * No auth middleware — verified by signature instead.
 */
export const handleWebhook = async (req, res) => {
  try {
    const signature = req.headers['x-webhook-signature'];
    const timestamp = req.headers['x-webhook-timestamp'];
    const rawBody   = JSON.stringify(req.body);

    if (signature && timestamp) {
      const valid = svc.verifyWebhookSignature({ rawBody, signature, timestamp });
      if (!valid) return res.status(401).json({ message: 'Invalid webhook signature' });
    }

    const { type, data } = req.body;
    console.log('[Cashfree Webhook]', type, data?.order?.order_id);
    // You can add DB updates here for PAYMENT_SUCCESS / PAYMENT_FAILED events
    res.json({ status: 'ok' });
  } catch (e) {
    console.error('[Payment] webhook error:', e.message);
    res.status(500).json({ message: e.message });
  }
};