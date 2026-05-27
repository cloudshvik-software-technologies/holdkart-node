import * as svc from '../services/reviewService.js';
  export const addReview         = async (req, res) => { try { res.json(await svc.addReview({ ...req.body, customerId: req.customer.id })); } catch(e) { res.status(500).json({ message: e.message }); } };
  export const getProductReviews = async (req, res) => { try { res.json(await svc.getProductReviews(req.params.productId)); } catch(e) { res.status(500).json({ message: e.message }); } };
  