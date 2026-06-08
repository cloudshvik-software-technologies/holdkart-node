import { Router } from 'express';
import * as c from '../controllers/paymentController.js';
import { authenticate } from '../middleware/auth.js';

const r = Router();

// Webhook does NOT need auth — Cashfree calls it server-to-server
r.post('/webhook', c.handleWebhook);

// All other payment routes require the customer to be logged in
r.use(authenticate);
r.post('/create-order', c.createOrder);
r.post('/verify',       c.verifyPayment);

export default r;
