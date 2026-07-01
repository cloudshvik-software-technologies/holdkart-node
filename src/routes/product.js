import { Router } from 'express';
import * as c from '../controllers/productController.js';
import * as vc from '../controllers/productVariantController.js';
import { authenticate } from '../middleware/auth.js';

const r = Router();

// ── Public routes (no auth required) ─────────────────────────────────────────
r.get('/list',                      c.listProducts);
r.get('/categories',                c.getCategories);
r.get('/featured',                  c.getFeatured);

// Guest section endpoints — used when not logged in
// type: 'deals' | 'trending' | 'top_rated'
r.get('/guest-section/:type',       c.getGuestSection);

// ── Authenticated routes ──────────────────────────────────────────────────────
// Track a product view for personalisation (fire-and-forget from the frontend)
r.post('/track-view/:productId',    authenticate, c.trackView);

// Personalized home page sections
r.get('/personalized/browsing',     authenticate, c.getPersonalizedBrowsing);
r.get('/personalized/cart',         authenticate, c.getPersonalizedCart);
r.get('/personalized/suggested',    authenticate, c.getPersonalizedSuggested);

// ── Parameterised routes last (so named routes above are matched first) ───────
r.get('/:productId/delivery-estimate', c.getDeliveryEstimate);
r.get('/:productId/variants',       vc.getVariants);
r.get('/:productId',                c.getProduct);

export default r;