import { Router } from 'express';
  import * as c from '../controllers/productController.js';
  const r = Router();
  r.get('/list',             c.listProducts);
  r.get('/categories',       c.getCategories);
  r.get('/featured',         c.getFeatured);
  r.get('/:productId',       c.getProduct);
  export default r;
  