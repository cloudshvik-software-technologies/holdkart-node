import crypto from 'crypto';

const CASHFREE_APP_ID     = process.env.CASHFREE_APP_ID     || '';
const CASHFREE_SECRET_KEY = process.env.CASHFREE_SECRET_KEY || '';
// Cashfree test environment base URL
const CF_BASE_URL = 'https://sandbox.cashfree.com/pg';

/**
 * Create a Cashfree payment order (test/sandbox).
 * Returns the order_id and payment_session_id needed by the JS SDK.
 */
export const createOrder = async ({ amount, currency = 'INR', receipt, customerInfo = {} }) => {
  const orderId = receipt || 'hk_' + Date.now();

  const body = {
    order_id:       orderId,
    order_amount:   Number(amount).toFixed(2),
    order_currency: currency,
    customer_details: {
      customer_id:    customerInfo.customerId || 'cust_' + Date.now(),
      customer_email: customerInfo.email      || 'customer@holdkart.com',
      customer_phone: customerInfo.phone      || '9999999999',
      customer_name:  customerInfo.name       || 'HoldKart Customer',
    },
    order_meta: {
      return_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/orders?order_id={order_id}`,
      notify_url: `${process.env.BACKEND_URL  || 'http://localhost:8081'}/api/customer/payment/webhook`,
    },
  };

  const response = await fetch(`${CF_BASE_URL}/orders`, {
    method:  'POST',
    headers: {
      'Content-Type':   'application/json',
      'x-api-version':  '2023-08-01',
      'x-client-id':    CASHFREE_APP_ID,
      'x-client-secret': CASHFREE_SECRET_KEY,
    },
    body: JSON.stringify(body),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.message || 'Cashfree order creation failed');
  }

  return {
    orderId:          data.order_id,
    paymentSessionId: data.payment_session_id,
    amount:           data.order_amount,
    currency:         data.order_currency,
    appId:            CASHFREE_APP_ID,
  };
};

/**
 * Verify Cashfree payment by fetching order status from API.
 * Returns true only when payment_status === 'PAID'.
 */
export const verifyPayment = async ({ orderId }) => {
  const response = await fetch(`${CF_BASE_URL}/orders/${orderId}`, {
    method:  'GET',
    headers: {
      'x-api-version':   '2023-08-01',
      'x-client-id':     CASHFREE_APP_ID,
      'x-client-secret': CASHFREE_SECRET_KEY,
    },
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.message || 'Cashfree order fetch failed');
  }

  return data.order_status === 'PAID';
};

/**
 * Verify Cashfree webhook signature.
 * Cashfree signs: timestamp + rawBody  using HMAC-SHA256.
 */
export const verifyWebhookSignature = ({ rawBody, signature, timestamp }) => {
  const signatureData = timestamp + rawBody;
  const expected = crypto
    .createHmac('sha256', CASHFREE_SECRET_KEY)
    .update(signatureData)
    .digest('base64');
  return expected === signature;
};

/**
 * Initiate a refund via Cashfree for a completed payment order.
 * @param {object} params
 * @param {string} params.cashfreeOrderId  - the Cashfree order_id used during payment
 * @param {string} params.refundId         - unique refund ID (e.g. 'refund_<orderId>_<ts>')
 * @param {number} params.amount           - amount to refund in INR
 * @param {string} [params.note]           - optional refund note shown to customer
 * Returns the Cashfree refund response object.
 */
export const initiateRefund = async ({ cashfreeOrderId, refundId, amount, note = 'Order cancelled by customer' }) => {
  const body = {
    refund_amount: Number(amount).toFixed(2),
    refund_id:     refundId,
    refund_note:   note,
  };

  const response = await fetch(`${CF_BASE_URL}/orders/${cashfreeOrderId}/refunds`, {
    method: 'POST',
    headers: {
      'Content-Type':    'application/json',
      'x-api-version':   '2023-08-01',
      'x-client-id':     CASHFREE_APP_ID,
      'x-client-secret': CASHFREE_SECRET_KEY,
    },
    body: JSON.stringify(body),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.message || 'Cashfree refund initiation failed');
  }

  return data; // { cf_refund_id, refund_id, order_id, refund_amount, refund_status, ... }
};