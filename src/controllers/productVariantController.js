// src/controllers/productVariantController.js
import * as variantService from '../services/productVariantService.js';

// Public, read-only — lets the product detail page fetch colour/size
// options (and their per-variant price + stock) for the variant selector.
export const getVariants = async (req, res) => {
  try {
    const variants = await variantService.getVariants(req.params.productId);
    res.json(variants);
  } catch (err) {
    console.error('[customer getVariants]', err);
    res.status(500).json({ message: err.message || 'Failed to load variants' });
  }
};