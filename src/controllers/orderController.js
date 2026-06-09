import * as svc from '../services/orderService.js';
  const s = (e) => e.status || 500;
  export const placeOrder  = async (req, res) => { try { res.status(201).json(await svc.placeOrder({ ...req.body, customerId: req.customer.id })); } catch(e) { res.status(s(e)).json({ message: e.message }); } };
  export const listOrders  = async (req, res) => { try { res.json(await svc.listOrders(req.customer.id)); } catch(e) { res.status(500).json({ message: e.message }); } };
  export const getOrder    = async (req, res) => { try { const o = await svc.getOrder(req.params.orderId, req.customer.id); if (!o) return res.status(404).json({ message: 'Not found' }); res.json(o); } catch(e) { res.status(500).json({ message: e.message }); } };
  export const cancelOrder = async (req, res) => { try { res.json(await svc.cancelOrder({ ...req.body, customerId: req.customer.id })); } catch(e) { res.status(s(e)).json({ message: e.message }); } };
  export const returnOrder = async (req, res) => { try { res.json(await svc.returnOrder({ ...req.body, customerId: req.customer.id })); } catch(e) { res.status(s(e)).json({ message: e.message }); } };
  export const trackOrder  = async (req, res) => { try { res.json(await svc.trackOrder(req.params.orderId, req.customer.id)); } catch(e) { res.status(s(e)).json({ message: e.message }); } };