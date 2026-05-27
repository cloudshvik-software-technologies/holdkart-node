import { Router } from 'express';
  import * as c from '../controllers/cartController.js';
  import { authenticate } from '../middleware/auth.js';
  const r = Router();
  r.use(authenticate);
  r.post('/add',    c.addToCart);
  r.get('/list',    c.getCart);
  r.put('/update',  c.updateCartItem);
  r.delete('/remove', c.removeFromCart);
  r.delete('/clear', c.clearCart);
  export default r;
  