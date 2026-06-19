// src/routes/shipping.js
import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { getAvailableCouriers } from '../controllers/shippingController.js';

const router = Router();

// GET /api/customer/shipping/couriers?destPin=600001&weight=0.5&cod=0
router.get('/couriers', authenticate, getAvailableCouriers);

export default router;