// src/controllers/shippingController.js
import db from '../config/db.js';
import * as shiprocketService from '../services/shiprocketService.js';

/**
 * GET /api/customer/shipping/couriers
 * Query params:
 *   productId    — required; used to look up the seller's pickup pincode
 *   destPin      — required; customer's delivery pincode
 *   weight       — parcel weight in kg (default 0.5)
 *   cod          — 1 / true for cash-on-delivery (default 0)
 *   declaredValue — declared value in ₹ (default 500)
 *
 * Pickup pincode resolution order:
 *   1. seller.pin_code (profile pincode of the product's seller)
 *   2. shipping config_json pickupAddress pincode (last 6 digits heuristic)
 *   3. SELLER_PINCODE env var fallback
 */
export const getAvailableCouriers = async (req, res) => {
  try {
    const {
      productId,
      destPin,
      weight = 0.5,
      cod = 0,
      declaredValue = 500,
    } = req.query;

    if (!destPin) {
      return res.status(400).json({ message: 'destPin (delivery pincode) is required' });
    }
    if (!productId) {
      return res.status(400).json({ message: 'productId is required' });
    }

    // ── Step 1: Resolve seller pincode from the product's seller ─────────────
    let pickupPin = null;

    // Primary: seller profile pin_code
    const [sellerRows] = await db.query(
      `SELECT s.pin_code
       FROM product p
       JOIN seller s ON s.id = p.seller_id
       WHERE p.id = ?
       LIMIT 1`,
      [productId]
    );

    if (sellerRows.length && sellerRows[0].pin_code) {
      pickupPin = String(sellerRows[0].pin_code).trim();
    }

    // Fallback 1: seller's shipping config pickupAddress (extract trailing 6-digit pincode)
    if (!pickupPin || !/^\d{6}$/.test(pickupPin)) {
      const [configRows] = await db.query(
        `SELECT sh.config_json
         FROM product p
         JOIN shipping sh ON sh.seller_id = p.seller_id AND sh.order_id IS NULL
         WHERE p.id = ?
         LIMIT 1`,
        [productId]
      );
      if (configRows.length && configRows[0].config_json) {
        try {
          const cfg = JSON.parse(configRows[0].config_json);
          const addr = cfg.pickupAddress || '';
          const match = addr.match(/\b(\d{6})\b/);
          if (match) pickupPin = match[1];
        } catch (_) {}
      }
    }

    // Fallback 2: env var
    if (!pickupPin || !/^\d{6}$/.test(pickupPin)) {
      pickupPin = process.env.SELLER_PINCODE || null;
    }

    if (!pickupPin) {
      return res.status(400).json({
        message: 'Could not determine seller pickup pincode. Please contact support.',
      });
    }

    if (String(pickupPin) === String(destPin)) {
      return res.status(400).json({
        message: 'Pickup and delivery pincodes cannot be the same',
      });
    }

    const couriers = await shiprocketService.getAvailableCouriers(
      pickupPin,
      destPin,
      parseFloat(weight),
      cod === '1' || cod === 'true',
      parseFloat(declaredValue) || 500,
    );

    res.json({ couriers, count: couriers.length, originPin: pickupPin });
  } catch (err) {
    console.error('[getAvailableCouriers]', err);
    let message = err.message || 'Failed to fetch couriers';
    try {
      const match = message.match(/\{.*\}/s);
      if (match) {
        const parsed = JSON.parse(match[0]);
        if (parsed?.message) message = `Shiprocket: ${parsed.message}`;
      }
    } catch (_) {}
    res.status(500).json({ message });
  }
};