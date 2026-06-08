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

export const getProductReviews = async (req, res) => {
  try {
    res.json(await svc.getProductReviews(req.params.productId));
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};