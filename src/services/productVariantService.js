// src/services/productVariantService.js
//
// Variant (SKU) support for products with multiple colors/sizes.
// Sits alongside productService.js — does not modify existing functions there.
//
// Live DB columns (Dump20260630.sql):
//   product_variant:
//     id, product_id, sku varchar(64) UNIQUE NOT NULL, color varchar(64),
//     size varchar(32), price_override, stock_quantity, reserved_stock,
//     min_stock_level, active bit(1), created_at
//     UNIQUE KEY uniq_product_color_size (product_id, color, size)
//   product_variant_image:
//     id, variant_id, image_url varchar(255), sort_order
//
// available_stock = stock_quantity - reserved_stock  (same convention as product table)
//
// Image ordering convention: the image with the LOWEST sort_order for a
// variant is the "primary" photo (shown first / on top in the seller UI and
// on the buyer-facing product card for that color). New uploads are appended
// after the current images unless makePrimary is requested, in which case
// they're inserted ahead of everything else.

import db from '../config/db.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const isActive = (v) => v === 1 || v === true || (Buffer.isBuffer(v) && v[0] === 1);

const slugify = (s) =>
  String(s || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 12) || 'VAR';

const generateSku = (productId, color, size) => {
  const parts = [productId, slugify(color), slugify(size)].filter(Boolean);
  return parts.join('-').slice(0, 64); // sku column is varchar(64)
};

// Friendly label for duplicate-combo errors, e.g. "Red / M" or "Red" or "M"
const comboLabel = (color, size) => [color, size].filter(Boolean).join(' / ') || 'this combination';

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
    reservedStock:  reserved,
    availableStock: Math.max(0, stock - reserved),
    minStockLevel:  parseInt(r.min_stock_level) || 0,
    active:         isActive(r.active),
    // FIX: previously a MySQL GROUP_CONCAT of bare URL strings — the frontend had
    // no image id to target for delete/set-primary. Now { id, url } pairs,
    // already ordered primary-first (lowest sort_order first).
    images:         imagesByVariant[r.id] || [],
    // Only this exact colour/size is blocked from a new campaign — a product
    // can have several variants, each with its own independent campaign state.
    hasActiveCampaign: Boolean(r.active_campaign_id),
  };
};

// ── fetchImagesForVariants ──────────────────────────────────────────────────
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

// ── syncProductStockFromVariants ────────────────────────────────────────────
// Keeps product.stock_quantity / reserved_stock as a cached sum of its
// variants, so every existing screen that reads those two columns
// (Products list, campaign wizard, stock-status badges) keeps working
// unchanged for variant products too.
const syncProductStockFromVariants = async (productId) => {
  const [[totals]] = await db.query(
    `SELECT COALESCE(SUM(stock_quantity),0) AS total,
            COALESCE(SUM(reserved_stock),0) AS reserved
     FROM product_variant WHERE product_id = ?`,
    [productId]
  );
  await db.query(
    `UPDATE product SET stock_quantity = ?, reserved_stock = ?, has_variants = true WHERE id = ?`,
    [totals.total, totals.reserved, productId]
  );
};

// ── syncProductPriceFromVariants ────────────────────────────────────────────
// The top "Retail Price" field on Add/Edit Product isn't required when
// variants are enabled (each variant carries its own priceOverride
// instead). For variant products, product.retail_price ALWAYS mirrors the
// first variant's price (insertion order, i.e. lowest variant id) — so it
// stays correct not just on first save, but every time that first
// variant's price gets edited later too.
//
// FIX (was the bug): the previous version only filled this in when
// product.retail_price was still 0, so once a price existed — even an old
// stale one from before variants were added — later variant price edits
// were silently ignored. This version has no such guard: it re-derives
// retail_price from the current first variant on every call.
const syncProductPriceFromVariants = async (productId) => {
  const [rows] = await db.query(
    `SELECT price_override FROM product_variant
     WHERE product_id = ? AND price_override IS NOT NULL AND price_override > 0
     ORDER BY id ASC
     LIMIT 1`,
    [productId]
  );
  if (!rows.length) return; // no variant has its own price yet — nothing to mirror

  await db.query('UPDATE product SET retail_price = ? WHERE id = ?', [rows[0].price_override, productId]);
};

// ── getVariants ──────────────────────────────────────────────────────────────
export const getVariants = async (productId) => {
  const [rows] = await db.query(
    `SELECT pv.*,
       (SELECT ac.id FROM campaign ac WHERE ac.variant_id = pv.id AND ac.status = 'ACTIVE' LIMIT 1) AS active_campaign_id
     FROM product_variant pv WHERE pv.product_id = ? ORDER BY pv.color, pv.size`,
    [productId]
  );
  if (!rows.length) return [];
  const imagesByVariant = await fetchImagesForVariants(rows.map((r) => r.id));
  return rows.map((r) => toVariantResponse(r, imagesByVariant));
};

// ── setVariants ──────────────────────────────────────────────────────────────
// Full replace-style upsert: pass the complete desired variant list for a
// product. Existing rows not present in the payload (by id) are removed.
//
// variants: [{ id?, color, size, priceOverride, stock, minStockLevel }]
// NOTE: image management is handled separately via addVariantImages /
// deleteVariantImage / setPrimaryVariantImage — setVariants no longer
// touches product_variant_image directly, so saving stock/price never
// accidentally wipes a color's photos.
//
// FIX: product_variant has UNIQUE KEY uniq_product_color_size(product_id,
// color, size). Previously, saving two variants with the same color+size
// threw a raw, unhandled MySQL ER_DUP_ENTRY error → ugly 500 with a SQL
// message leaking to the seller. Now: duplicates within the same submitted
// payload are rejected up front with a clear message, and any duplicate
// that still reaches MySQL is caught and turned into a clean 409.
export const setVariants = async ({ productId, variants }) => {
  if (!productId) throw new Error('productId is required');
  if (!Array.isArray(variants) || variants.length === 0) {
    throw new Error('At least one variant is required');
  }

  const [productRows] = await db.query('SELECT id FROM product WHERE id = ?', [productId]);
  if (!productRows.length) throw Object.assign(new Error('Product not found'), { status: 404 });

  // Reject duplicate color+size combos within this submission before touching the DB.
  const seen = new Set();
  for (const v of variants) {
    const key = `${(v.color || '').trim().toLowerCase()}|${(v.size || '').trim().toLowerCase()}`;
    if (seen.has(key)) {
      throw Object.assign(
        new Error(`Duplicate variant: ${comboLabel(v.color, v.size)} was entered more than once`),
        { status: 409 }
      );
    }
    seen.add(key);
  }

  const keepIds = variants.filter((v) => v.id).map((v) => v.id);
  if (keepIds.length) {
    await db.query(
      `DELETE FROM product_variant WHERE product_id = ? AND id NOT IN (${keepIds.map(() => '?').join(',')})`,
      [productId, ...keepIds]
    );
  } else {
    await db.query('DELETE FROM product_variant WHERE product_id = ?', [productId]);
  }

  for (const v of variants) {
    const safeStock    = Number(v.stock) || 0;
    const safeMinStock = Number(v.minStockLevel) || 0;
    const safePrice    = v.priceOverride != null && v.priceOverride !== '' ? Number(v.priceOverride) : null;
    const color        = v.color || null;
    const size          = v.size || null;

    try {
      if (v.id) {
        await db.query(
          `UPDATE product_variant
           SET color = ?, size = ?, price_override = ?, stock_quantity = ?, min_stock_level = ?
           WHERE id = ? AND product_id = ?`,
          [color, size, safePrice, safeStock, safeMinStock, v.id, productId]
        );
      } else {
        const sku = v.sku || generateSku(productId, color, size);
        await db.query(
          `INSERT INTO product_variant
             (product_id, sku, color, size, price_override, stock_quantity, min_stock_level, active)
           VALUES (?, ?, ?, ?, ?, ?, ?, true)`,
          [productId, sku, color, size, safePrice, safeStock, safeMinStock]
        );
      }
    } catch (err) {
      if (err.code === '23505') {
        throw Object.assign(
          new Error(`You already have a "${comboLabel(color, size)}" variant for this product`),
          { status: 409 }
        );
      }
      throw err;
    }
  }

  await syncProductStockFromVariants(productId);
  await syncProductPriceFromVariants(productId);
  return getVariants(productId);
};

// ── updateVariantStock ───────────────────────────────────────────────────────
// Mirrors productService.updateStock's "can't drop below reserved" guard.
export const updateVariantStock = async ({ productId, variantId, stock, minStockLevel }) => {
  const [rows] = await db.query(
    'SELECT id, reserved_stock FROM product_variant WHERE id = ? AND product_id = ?',
    [variantId, productId]
  );
  if (!rows.length) return null;

  const newStock    = Number(stock) || 0;
  const reservedQty = parseInt(rows[0].reserved_stock) || 0;

  if (newStock < reservedQty) {
    throw Object.assign(
      new Error(`Cannot set stock to ${newStock} — ${reservedQty} units are already reserved by active campaigns`),
      { status: 409 }
    );
  }

  await db.query(
    `UPDATE product_variant SET stock_quantity = ?, min_stock_level = ? WHERE id = ?`,
    [newStock, Number(minStockLevel) || 0, variantId]
  );

  await syncProductStockFromVariants(productId);
  return { message: 'Variant stock updated successfully' };
};

// ── syncProductImageFromVariants ────────────────────────────────────────────
// The top "Product Images" box on Add/Edit Product is optional for variant
// products — sellers often skip it and only upload photos per color/size.
// Without this, product.image_url stays empty forever and the product card
// on Products / buyer pages shows a blank image, even though photos exist.
//
// Rule: only fill in when the seller hasn't set a main image themselves.
// If product.image_url already has something (seller uploaded one, or a
// previous auto-fill already ran), we never touch it — the seller's own
// choice always wins. When it's empty, we default it to the first photo of
// the first variant that has one (variant order = insertion order, image
// order = each variant's primary photo, i.e. lowest sort_order).
const syncProductImageFromVariants = async (productId) => {
  const [[product]] = await db.query('SELECT image_url FROM product WHERE id = ?', [productId]);
  if (!product) return;

  const raw = product.image_url;
  let existing = [];
  if (raw) {
    if (typeof raw === 'string' && raw.startsWith('[')) {
      try { existing = JSON.parse(raw).filter(Boolean); } catch { existing = []; }
    } else {
      existing = [raw];
    }
  }
  if (existing.length) return; // seller already has a main image — don't override

  const [rows] = await db.query(
    `SELECT pvi.image_url
     FROM product_variant_image pvi
     JOIN product_variant pv ON pv.id = pvi.variant_id
     WHERE pv.product_id = ?
     ORDER BY pv.id ASC, pvi.sort_order ASC, pvi.id ASC
     LIMIT 1`,
    [productId]
  );
  if (!rows.length) return; // no variant photos yet either — nothing to fall back to

  await db.query(
    'UPDATE product SET image_url = ? WHERE id = ?',
    [JSON.stringify([rows[0].image_url]), productId]
  );
};

// ── addVariantImages ─────────────────────────────────────────────────────────
// Appends uploaded photo paths to a variant's gallery (does NOT wipe existing
// images — use deleteVariantImage to remove one, or pass reset=true to clear
// first, mirroring productService.uploadImage's `reset` convention).
//
// makePrimary: if true, the FIRST file in this upload batch is given a
// sort_order lower than every existing image for the variant, so it becomes
// the primary photo — e.g. a shirt that already has a Blue-front photo gets
// a new Blue-side photo marked primary, and the side photo now shows first
// while the front photo drops below it. Without makePrimary, new photos are
// simply appended after whatever's already there.
export const addVariantImages = async ({ productId, variantId, imageUrls, reset, makePrimary }) => {
  const [rows] = await db.query(
    'SELECT id FROM product_variant WHERE id = ? AND product_id = ?',
    [variantId, productId]
  );
  if (!rows.length) return null;

  if (reset) {
    await db.query('DELETE FROM product_variant_image WHERE variant_id = ?', [variantId]);
  }

  const [[{ minSort, maxSort }]] = await db.query(
    `SELECT COALESCE(MIN(sort_order), 0) AS "minSort", COALESCE(MAX(sort_order), -1) AS "maxSort"
     FROM product_variant_image WHERE variant_id = ?`,
    [variantId]
  );

  let nextSort = makePrimary ? (minSort - imageUrls.length) : (maxSort + 1);
  const insertedIds = [];
  for (const url of imageUrls) {
    const [result] = await db.query(
      'INSERT INTO product_variant_image (variant_id, image_url, sort_order) VALUES (?, ?, ?)',
      [variantId, url, nextSort++]
    );
    insertedIds.push(result.insertId);
  }

  const images = (await fetchImagesForVariants([variantId]))[variantId] || [];

  // Fill in the product's main image if it's still empty — see
  // syncProductImageFromVariants for why this only happens when empty.
  await syncProductImageFromVariants(productId);

  return { images, insertedIds };
};

// ── setPrimaryVariantImage ───────────────────────────────────────────────────
// Promotes one existing image to the front of the gallery (primary / top
// position) without touching any other image's relative order.
export const setPrimaryVariantImage = async ({ productId, variantId, imageId }) => {
  const [rows] = await db.query(
    `SELECT i.id FROM product_variant_image i
     JOIN product_variant v ON v.id = i.variant_id
     WHERE i.id = ? AND i.variant_id = ? AND v.product_id = ?`,
    [imageId, variantId, productId]
  );
  if (!rows.length) return null;

  const [[{ minSort }]] = await db.query(
    'SELECT COALESCE(MIN(sort_order), 0) AS "minSort" FROM product_variant_image WHERE variant_id = ?',
    [variantId]
  );

  await db.query(
    'UPDATE product_variant_image SET sort_order = ? WHERE id = ?',
    [minSort - 1, imageId]
  );

  const images = (await fetchImagesForVariants([variantId]))[variantId] || [];
  return { images };
};

// ── deleteVariantImage ───────────────────────────────────────────────────────
export const deleteVariantImage = async ({ productId, variantId, imageId }) => {
  const [rows] = await db.query(
    `SELECT i.id FROM product_variant_image i
     JOIN product_variant v ON v.id = i.variant_id
     WHERE i.id = ? AND i.variant_id = ? AND v.product_id = ?`,
    [imageId, variantId, productId]
  );
  if (!rows.length) return null;

  await db.query('DELETE FROM product_variant_image WHERE id = ?', [imageId]);

  const images = (await fetchImagesForVariants([variantId]))[variantId] || [];
  return { images };
};

// ── deleteVariant ────────────────────────────────────────────────────────────
export const deleteVariant = async ({ productId, variantId }) => {
  const [result] = await db.query(
    'DELETE FROM product_variant WHERE id = ? AND product_id = ?',
    [variantId, productId]
  );
  if (!result.affectedRows) return null;
  await syncProductStockFromVariants(productId);
  await syncProductPriceFromVariants(productId); // re-mirror in case the first variant was the one just deleted
  return { message: 'Variant deleted successfully' };
};