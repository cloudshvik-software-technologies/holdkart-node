import { Router } from 'express';
import * as c from '../controllers/reviewController.js';
import { authenticate } from '../middleware/auth.js';
import { uploadReviewImages } from '../middleware/upload.js';

const r = Router();

// Check if authenticated customer is eligible to review a product
r.get('/can-review/:productId', authenticate, c.checkCanReview);
r.get('/reviewed-products',    authenticate, c.getReviewedProducts);

// Submit a review (with optional image attachments — multipart/form-data)
r.post('/add', authenticate, uploadReviewImages, c.addReview);

// Public: fetch all reviews for a product (sends userVote if authenticated)
r.get('/list/:productId', c.getProductReviews);

// Toggle like on a review (authenticated customers only)
r.post('/:reviewId/like', authenticate, c.toggleReviewLike);

// Get current customer's review for a specific order
r.get('/my-review/:orderId', authenticate, c.getMyReview);

// Delete a review by id (owner only)
r.delete('/:reviewId', authenticate, c.deleteReview);

export default r;