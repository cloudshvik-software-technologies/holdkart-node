import * as svc from '../services/cartService.js';
  export const addToCart       = async (req, res) => { try { res.json(await svc.addToCart({ ...req.body, customerId: req.customer.id })); } catch(e) { res.status(500).json({ message: e.message }); } };
  export const getCart         = async (req, res) => { try { res.json(await svc.getCart(req.customer.id)); } catch(e) { res.status(500).json({ message: e.message }); } };
  export const updateCartItem  = async (req, res) => { try { res.json(await svc.updateCartItem({ ...req.body, customerId: req.customer.id })); } catch(e) { res.status(500).json({ message: e.message }); } };
  export const removeFromCart  = async (req, res) => { try { res.json(await svc.removeFromCart({ ...req.body, customerId: req.customer.id })); } catch(e) { res.status(500).json({ message: e.message }); } };
  export const clearCart       = async (req, res) => { try { res.json(await svc.clearCart(req.customer.id)); } catch(e) { res.status(500).json({ message: e.message }); } };
  