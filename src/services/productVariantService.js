// src/services/productVariantService.js
//
// Read-only variant lookup for the customer storefront. Mirrors the seller
// portal's `product_variant` / `product_variant_image` tables (see
// holdkart-seller-node/src/services/productVariantService.js) — this file
// does not write to those tables, it only exposes them to buyers so the
// product detail page can offer a colour/size selector with per-variant
// pricing and stock, the same way the seller already sees it.
//
// Live DB columns (shared MySQL instance):
//   product_variant:
//     id, product_id, sku, color, size, price_override, stock_quantity,
//     reserved_stock, min_stock_level, active, created_at
//   product_variant_image:
//     id, variant_id, image_url, sort_order
//
// Only ACTIVE variants are returned to customers — inactive/retired
// variants configured by the seller stay hidden from the storefront.

import db from '../config/db.js';

const isActive = (v) => v === 1 || v === true || (Buffer.isBuffer(v) && v[0] === 1);

const toVariantResponse = (r, imagesByVariant) => {
  const stock    = parseInt(r.stock_quantity) || 0;
  const reserved = parseInt(r.reserved_stock) || 0;
  return {
    id:             r.id,
    productId:      r.product_id,
    sku:            r.sku,
    color:          r.color,
    size:           r.size,
    price:          r.price_override != null ? Number(r.price_override) : null,
    stock,
    availableStock: Math.max(0, stock - reserved),
    images:         imagesByVariant[r.id] || [],
  };
};

const fetchImagesForVariants = async (variantIds) => {
  if (!variantIds.length) return {};
  const [rows] = await db.query(
    `SELECT id, variant_id, image_url, sort_order
     FROM product_variant_image
     WHERE variant_id IN (${variantIds.map(() => '?').join(',')})
     ORDER BY variant_id, sort_order, id`,
    variantIds
  );
  const map = {};
  for (const row of rows) {
    if (!map[row.variant_id]) map[row.variant_id] = [];
    map[row.variant_id].push({ id: row.id, url: row.image_url });
  }
  return map;
};

// ── getVariants ──────────────────────────────────────────────────────────────
// Returns only active variants for a product, ordered the same way the
// seller portal orders them (by colour, then size) so swatch order stays
// consistent between the two portals.
export const getVariants = async (productId) => {
  const [rows] = await db.query(
    `SELECT * FROM product_variant WHERE product_id = ? AND active = true ORDER BY color, size`,
    [productId]
  );
  const activeRows = rows.filter((r) => isActive(r.active));
  if (!activeRows.length) return [];
  const imagesByVariant = await fetchImagesForVariants(activeRows.map((r) => r.id));
  return activeRows.map((r) => toVariantResponse(r, imagesByVariant));
};