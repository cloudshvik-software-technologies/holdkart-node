import * as svc from '../services/productService.js';
  export const listProducts    = async (req, res) => { try { res.json(await svc.listProducts(req.query)); } catch(e) { res.status(500).json({ message: e.message }); } };
  export const getProduct      = async (req, res) => { try { const p = await svc.getProduct(req.params.productId); if (!p) return res.status(404).json({ message: 'Not found' }); res.json(p); } catch(e) { res.status(500).json({ message: e.message }); } };
  export const getCategories   = async (req, res) => { try { res.json(await svc.getCategories()); } catch(e) { res.status(500).json({ message: e.message }); } };
  export const getFeatured     = async (req, res) => { try { res.json(await svc.getFeaturedProducts()); } catch(e) { res.status(500).json({ message: e.message }); } };
  