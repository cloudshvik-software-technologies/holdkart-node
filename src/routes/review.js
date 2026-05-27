import { Router } from 'express';
  import * as c from '../controllers/reviewController.js';
  import { authenticate } from '../middleware/auth.js';
  const r = Router();
  r.post('/add',            authenticate, c.addReview);
  r.get('/list/:productId', c.getProductReviews);
  export default r;
  