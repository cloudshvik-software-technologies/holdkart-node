import db from '../config/db.js';

// ─────────────────────────────────────────────────────────────────────────────
// UNIFIED LEDGER (Cash Flow & Settlement Fix Plan, §1 / §3.1)
//
// Every money movement — payment, refund, commission, seller credit, payout,
// courier cost, deal forfeiture — is appended here as one row. This is the
// single source of truth: every dashboard number (customer, seller, admin)
// is a filtered read of this table, never a second independent calculation.
//
// This exact file is copied into all three backends (customer/seller/admin
// node) since each is its own deployable service but they share one
// Postgres database. `createdBy` records which service wrote the row.
// ─────────────────────────────────────────────────────────────────────────────

const CREATED_BY = 'customer-node';

/**
 * Append one ledger row. Call this instead of ever writing seller_wallet /
 * transaction / payment / refund tables directly for a money event.
 * `conn` (optional) lets this run inside an existing transaction.
 */
export const appendLedgerEntry = async ({
  entryType, direction, amount,
  orderId = null, orderNumber = null, customerId = null, sellerId = null, campaignId = null,
  method = null, status = 'SUCCESS', referenceTable = null, referenceId = null,
  description = null,
}, conn = db) => {
  if (!entryType) throw new Error('appendLedgerEntry: entryType is required');
  if (!direction || !['CREDIT', 'DEBIT'].includes(direction)) {
    throw new Error('appendLedgerEntry: direction must be CREDIT or DEBIT');
  }
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt < 0) {
    throw new Error(`appendLedgerEntry: invalid amount ${amount}`);
  }

  // FIX: this insert previously could fail silently — callers in
  // campaignService (joinCampaign / startOrJoinCampaign / addToDeal) wrap
  // it in `.catch(e => console.error(...))`, which stops the failure from
  // breaking the customer's payment flow, but a truncated/generic message
  // was near-impossible to diagnose from logs. Log the full error object
  // (code, detail, table/column) here, at the source, before it's caught
  // upstream, so a failed write is actually traceable.
  try {
    const [result] = await conn.query(
      `INSERT INTO ledger_entry
         (entry_type, direction, order_id, order_number, customer_id, seller_id, campaign_id,
          amount, method, status, reference_table, reference_id, description, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [entryType, direction, orderId, orderNumber, customerId, sellerId, campaignId,
       amt, method, status, referenceTable, referenceId, description, CREATED_BY]
    );
    return result.insertId;
  } catch (err) {
    console.error('[ledgerService.appendLedgerEntry] INSERT FAILED', {
      entryType, direction, amount: amt, customerId, sellerId, campaignId,
      method, referenceTable, referenceId,
      pgCode: err.code, pgDetail: err.detail, message: err.message,
    });
    throw err;
  }
};

// ─── Shared commission calculation (§3.2) ───────────────────────────────────
// ONE function, called everywhere commission needs computing, so the admin
// commission-settings panel and the amount actually charged can never drift
// apart. Deal/campaign orders get a flat 5% override; everything else uses
// the category's own commission_pct (default 2%).
const DEAL_COMMISSION_PCT = 5;
const DEFAULT_COMMISSION_PCT = 2;

export const calcCommission = async ({ grossAmount, categoryId = null, isDealOrder = false }, conn = db) => {
  const gross = Number(grossAmount) || 0;
  let pct = DEFAULT_COMMISSION_PCT;

  if (isDealOrder) {
    pct = DEAL_COMMISSION_PCT;
  } else if (categoryId != null) {
    const [rows] = await conn.query(
      'SELECT commission_pct FROM category WHERE id = ?',
      [categoryId]
    );
    if (rows.length && rows[0].commission_pct != null) {
      pct = Number(rows[0].commission_pct);
    }
  }

  const commission = Math.round(gross * (pct / 100) * 100) / 100;
  const netAmount = Math.round((gross - commission) * 100) / 100;
  return { pct, commission, netAmount };
};

// ─── Reads — every dashboard should use these instead of re-deriving totals ─

export const getLedgerForOrder = async (orderId, conn = db) => {
  const [rows] = await conn.query(
    'SELECT * FROM ledger_entry WHERE order_id = ? ORDER BY id ASC',
    [orderId]
  );
  return rows;
};

export const getSellerLedgerBalance = async (sellerId, conn = db) => {
  const [rows] = await conn.query(
    `SELECT
       COALESCE(SUM(CASE WHEN entry_type = 'SELLER_CREDIT' AND direction = 'CREDIT' THEN amount ELSE 0 END), 0) AS total_credited,
       COALESCE(SUM(CASE WHEN entry_type = 'PAYOUT' AND direction = 'DEBIT' THEN amount ELSE 0 END), 0) AS total_paid_out
     FROM ledger_entry
     WHERE seller_id = ? AND status = 'SUCCESS'`,
    [sellerId]
  );
  const r = rows[0] || { total_credited: 0, total_paid_out: 0 };
  return {
    totalCredited: Number(r.total_credited) || 0,
    totalPaidOut: Number(r.total_paid_out) || 0,
  };
};

export default { appendLedgerEntry, calcCommission, getLedgerForOrder, getSellerLedgerBalance };