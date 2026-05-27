import { Router } from 'express';
  import * as c from '../controllers/orderController.js';
  import { authenticate } from '../middleware/auth.js';
  const r = Router();
  r.use(authenticate);
  r.post('/place',   c.placeOrder);
  r.get('/list',     c.listOrders);
  r.put('/cancel',   c.cancelOrder);
  r.get('/:orderId', c.getOrder);
  export default r;
  