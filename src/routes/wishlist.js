import { Router } from 'express';
  import * as c from '../controllers/wishlistController.js';
  import { authenticate } from '../middleware/auth.js';
  const r = Router();
  r.use(authenticate);
  r.post('/add',    c.addToWishlist);
  r.get('/list',    c.getWishlist);
  r.delete('/remove', c.removeFromWishlist);
  export default r;
  