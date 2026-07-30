// src/controllers/shippingController.js
import db from '../config/db.js';
import * as shiprocketService from '../services/shiprocketService.js';

/**
 * GET /api/customer/shipping/couriers
 * Query params:
 *   productId    — required; used to look up the seller's pickup pincode
 *                  AND the product's stored weight (specs.ship_weight)
 *   destPin      — customer's delivery pincode
 *   quantity     — number of units being ordered (default 1). The parcel
 *                  weight sent to Shiprocket is product.ship_weight * quantity,
 *                  so the returned rate already covers the whole shipment.
 *                  Do NOT multiply the returned rate by quantity again.
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
      quantity = 1,
      cod = 0,
      declaredValue = 500,
    } = req.query;

    if (!destPin) {
      return res.status(400).json({ message: 'destPin (delivery pincode) is required' });
    }
    if (!productId) {
      return res.status(400).json({ message: 'productId is required' });
    }

    // ── Step 1: Resolve seller pincode + product weight from the product ─────
    let pickupPin = null;

    // Primary: seller profile pin_code (+ product specs for weight)
    const [sellerRows] = await db.query(
      `SELECT s.pin_code, p.specs
       FROM product p
       JOIN seller s ON s.id = p.seller_id
       WHERE p.id = ?
       LIMIT 1`,
      [productId]
    );

    if (sellerRows.length && sellerRows[0].pin_code) {
      pickupPin = String(sellerRows[0].pin_code).trim();
    }

    // ── Resolve per-unit product weight (kg) from specs.ship_weight ──────────
    let unitWeight = null;
    if (sellerRows.length) {
      let specs = sellerRows[0].specs;
      if (typeof specs === 'string') {
        try { specs = JSON.parse(specs); } catch (_) { specs = null; }
      }
      const rawWeight = specs?.ship_weight;
      const parsedWeight = parseFloat(rawWeight);
      if (rawWeight != null && !Number.isNaN(parsedWeight) && parsedWeight > 0) {
        unitWeight = parsedWeight;
      }
    }

    if (unitWeight == null) {
      return res.status(400).json({
        message: 'This product is missing a package weight. Please ask the seller to set the product weight before checkout.',
      });
    }

    const qty = Math.max(1, parseInt(quantity, 10) || 1);
    const totalWeight = Math.round(unitWeight * qty * 1000) / 1000; // kg, 3dp

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
      totalWeight,
      cod === '1' || cod === 'true',
      parseFloat(declaredValue) || 500,
    );

    res.json({ couriers, count: couriers.length, originPin: pickupPin, weight: totalWeight });
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