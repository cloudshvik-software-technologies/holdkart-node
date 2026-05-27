import { Router } from 'express';
  import * as c from '../controllers/paymentController.js';
  import { authenticate } from '../middleware/auth.js';
  const r = Router();
  r.use(authenticate);
  r.post('/create-order', c.createOrder);
  r.post('/verify',       c.verifyPayment);
  export default r;
  