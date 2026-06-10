import * as svc from '../services/reviewService.js';

export const checkCanReview = async (req, res) => {
  try {
    const { productId } = req.params;
    const result = await svc.canReview({ customerId: req.customer.id, productId });
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ message: e.message });
  }
};

export const addReview = async (req, res) => {
  try {
    // req.files comes from multer (array of uploaded review images)
    const imagePaths = (req.files || []).map(f => `/uploads/reviews/${f.filename}`);
    const { productId, rating, comment } = req.body;
    await svc.addReview({
      customerId: req.customer.id,
      productId,
      rating: Number(rating),
      comment,
      imagePaths,
    });
    res.json({ message: 'Review submitted' });
  } catch (e) {
    res.status(e.status || 500).json({ message: e.message });
  }
};

export const getMyReview = async (req, res) => {
  try {
    const { orderId } = req.params;
    const review = await svc.getMyReview({ customerId: req.customer.id, orderId });
    res.json({ review: review || null });
  } catch (e) {
    res.status(e.status || 500).json({ message: e.message });
  }
};

export const deleteReview = async (req, res) => {
  try {
    const { reviewId } = req.params;
    const result = await svc.deleteReview({ customerId: req.customer.id, reviewId });
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ message: e.message });
  }
};

export const getReviewedProducts = async (req, res) => {
  try {
    const productIds = await svc.getReviewedProducts(req.customer.id);
    res.json({ productIds });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const getProductReviews = async (req, res) => {
  try {
    // Pass customer id if authenticated (Bearer token present), otherwise null
    let customerId = null;
    const header = req.headers.authorization;
    if (header && header.startsWith('Bearer ')) {
      try {
        const { verifyToken } = await import('../config/jwt.js');
        const decoded = verifyToken(header.split(' ')[1]);
        customerId = decoded.id;
      } catch { /* token invalid or absent — treat as guest */ }
    }
    res.json(await svc.getProductReviews(req.params.productId, customerId));
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

export const toggleReviewLike = async (req, res) => {
  try {
    const { reviewId } = req.params;
    const result = await svc.toggleReviewLike({ customerId: req.customer.id, reviewId });
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ message: e.message });
  }
};