import Razorpay from 'razorpay';
  import crypto from 'crypto';

  const getRazorpay = () => new Razorpay({
    key_id:     process.env.RAZORPAY_KEY_ID     || '',
    key_secret: process.env.RAZORPAY_KEY_SECRET || '',
  });

  export const createOrder = async ({ amount, currency = 'INR', receipt }) => {
    const rz = getRazorpay();
    const order = await rz.orders.create({ amount: Math.round(amount * 100), currency, receipt: receipt || 'hk_' + Date.now() });
    return { orderId: order.id, amount: order.amount, currency: order.currency, keyId: process.env.RAZORPAY_KEY_ID };
  };

  export const verifyPayment = ({ razorpay_order_id, razorpay_payment_id, razorpay_signature }) => {
    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || '').update(body).digest('hex');
    return expected === razorpay_signature;
  };
  