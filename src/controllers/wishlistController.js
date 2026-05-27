import * as svc from '../services/wishlistService.js';
  export const addToWishlist      = async (req, res) => { try { res.json(await svc.addToWishlist({ ...req.body, customerId: req.customer.id })); } catch(e) { res.status(500).json({ message: e.message }); } };
  export const getWishlist        = async (req, res) => { try { res.json(await svc.getWishlist(req.customer.id)); } catch(e) { res.status(500).json({ message: e.message }); } };
  export const removeFromWishlist = async (req, res) => { try { res.json(await svc.removeFromWishlist({ ...req.body, customerId: req.customer.id })); } catch(e) { res.status(500).json({ message: e.message }); } };
  