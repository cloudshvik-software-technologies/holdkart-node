import * as svc from '../services/productService.js';

export const getDeliveryEstimate = async (req, res) => {
  try {
    const { pincode } = req.query;
    const result = await svc.getDeliveryEstimate(req.params.productId, pincode);
    res.json(result);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

export const listProducts = async (req, res) => {
  try { res.json(await svc.listProducts(req.query)); }
  catch (e) { res.status(500).json({ message: e.message }); }
};

export const getProduct = async (req, res) => {
  try {
    const p = await svc.getProduct(req.params.productId);
    if (!p) return res.status(404).json({ message: 'Not found' });
    res.json(p);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

export const getCategories = async (req, res) => {
  try { res.json(await svc.getCategories()); }
  catch (e) { res.status(500).json({ message: e.message }); }
};

export const getFeatured = async (req, res) => {
  try { res.json(await svc.getFeaturedProducts(req.query)); }
  catch (e) { res.status(500).json({ message: e.message }); }
};

// ── Track product view (authenticated) ───────────────────────────────────────
export const trackView = async (req, res) => {
  try {
    const customerId = req.customer?.id || req.customer?.customerId;
    const { productId } = req.params;
    if (!customerId || !productId) return res.json({ ok: true });
    await svc.trackProductView(customerId, productId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// ── Personalized: Inspired by browsing history ────────────────────────────────
export const getPersonalizedBrowsing = async (req, res) => {
  try {
    const customerId = req.customer?.id || req.customer?.customerId;
    const limit = Number(req.query.limit) || 14;
    const data = await svc.getPersonalizedBrowsing(customerId, limit);
    res.json(data);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// ── Personalized: Based on your cart ─────────────────────────────────────────
export const getPersonalizedCart = async (req, res) => {
  try {
    const customerId = req.customer?.id || req.customer?.customerId;
    const limit = Number(req.query.limit) || 14;
    const data = await svc.getPersonalizedCart(customerId, limit);
    res.json(data);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// ── Personalized: Suggested for you ─────────────────────────────────────────
export const getPersonalizedSuggested = async (req, res) => {
  try {
    const customerId = req.customer?.id || req.customer?.customerId;
    const limit = Number(req.query.limit) || 14;
    const data = await svc.getPersonalizedSuggested(customerId, limit);
    res.json(data);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// ── Guest public sections ─────────────────────────────────────────────────────
export const getGuestSection = async (req, res) => {
  try {
    const { type } = req.params; // 'deals' | 'trending' | 'top_rated'
    const limit = Number(req.query.limit) || 14;
    const data = await svc.getGuestSectionProducts(type, limit);
    res.json(data);
  } catch (e) { res.status(500).json({ message: e.message }); }
};