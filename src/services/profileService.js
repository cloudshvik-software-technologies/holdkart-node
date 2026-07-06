import db from '../config/db.js';
import bcrypt from 'bcryptjs';

/* Columns that might or might not exist */
const ALL_OPTIONAL_COLS = ['mobile', 'phone', 'address', 'city', 'state', 'pincode', 'profile_image', 'active', 'created_date'];

let _colCache = null;

async function getCols() {
  if (_colCache) return _colCache;
  const [rows] = await db.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'customer'"
  );
  _colCache = new Set(rows.map(r => r.column_name));
  return _colCache;
}

export const invalidateColCache = () => { _colCache = null; };

export const getProfile = async (customerId) => {
  const cols = await getCols();

  // Only select columns that actually exist in this DB
  const wanted = ['id', 'name', 'email', ...ALL_OPTIONAL_COLS];
  const select = wanted.filter(c => cols.has(c)).join(', ');

  const [rows] = await db.query(
    `SELECT ${select} FROM customer WHERE id = ?`,
    [customerId]
  );
  return rows[0] || null;
};

export const updateProfile = async ({ customerId, name, mobile, address, city, state, pincode }) => {
  const cols = await getCols();

  const setClauses = ['name = ?'];
  const values     = [name];

  // Support both 'mobile' and 'phone' column names
  if (cols.has('mobile')) { setClauses.push('mobile = ?'); values.push(mobile || null); }
  if (cols.has('phone'))  { setClauses.push('phone = ?');  values.push(mobile || null); }
  if (cols.has('address')) { setClauses.push('address = ?'); values.push(address || null); }
  if (cols.has('city'))    { setClauses.push('city = ?');    values.push(city    || null); }
  if (cols.has('state'))   { setClauses.push('state = ?');   values.push(state   || null); }
  if (cols.has('pincode')) { setClauses.push('pincode = ?'); values.push(pincode || null); }

  values.push(customerId);
  await db.query(`UPDATE customer SET ${setClauses.join(', ')} WHERE id = ?`, values);
  return { message: 'Profile updated successfully' };
};

export const uploadProfileImage = async ({ customerId, imageUrl }) => {
  const cols = await getCols();
  if (!cols.has('profile_image')) {
    await db.query('ALTER TABLE customer ADD COLUMN IF NOT EXISTS profile_image TEXT');
    invalidateColCache();
  }
  await db.query('UPDATE customer SET profile_image = ? WHERE id = ?', [imageUrl, customerId]);
  return { message: 'Profile image updated', imageUrl };
};
export const deleteProfileImage = async ({ customerId }) => {
  const cols = await getCols();
  if (!cols.has('profile_image')) return { message: 'No profile image to delete' };
  await db.query('UPDATE customer SET profile_image = NULL WHERE id = ?', [customerId]);
  return { message: 'Profile image removed' };
};

// FLIPKART-STYLE DEACTIVATION
// Uses its own `deactivated_at` column rather than the existing `active`
// column (which is reserved for admin-side suspension in authService.js),
// so this feature never touches that existing behavior.
const REACTIVATION_WINDOW_DAYS = 30;

async function ensureDeactivationCols() {
  const cols = await getCols();
  if (!cols.has('deactivated_at')) {
    await db.query('ALTER TABLE customer ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMP NULL');
    invalidateColCache();
  }
  if (!cols.has('permanently_deleted_at')) {
    await db.query('ALTER TABLE customer ADD COLUMN IF NOT EXISTS permanently_deleted_at TIMESTAMP NULL');
    invalidateColCache();
  }
  if (!cols.has('deactivation_reason')) {
    await db.query('ALTER TABLE customer ADD COLUMN deactivation_reason TEXT NULL');
    invalidateColCache();
  }
}

// Returns pending orders, active deals, and current account status for
// the 3-step deactivation modal (step 2 — account info review).
export const getDeactivationInfo = async (customerId) => {
  await ensureDeactivationCols();

  const [[orderRow]] = await db.query(
    `SELECT COUNT(*) AS cnt FROM orders WHERE customer_id = ? AND order_status NOT IN ('Delivered', 'Cancelled')`,
    [customerId]
  );
  const [[dealRow]] = await db.query(
    `SELECT COUNT(*) AS cnt FROM campaign_hold ch
     JOIN campaign c ON c.id = ch.campaign_id
     WHERE ch.customer_id = ? AND c.status IN ('ACTIVE', 'PAUSED')`,
    [customerId]
  );
  const [rows] = await db.query(
    'SELECT id, deactivated_at, permanently_deleted_at FROM customer WHERE id = ?',
    [customerId]
  );
  const customer = rows[0];

  const deactivatedAt = customer?.deactivated_at || null;
  const daysLeftToRecover = deactivatedAt
    ? Math.max(0, Math.ceil(REACTIVATION_WINDOW_DAYS - (Date.now() - new Date(deactivatedAt).getTime()) / 86400000))
    : null;

  return {
    pendingOrders:     orderRow.cnt,
    activeDeals:       dealRow.cnt,
    accountStatus:     deactivatedAt ? 'deactivation_pending' : 'active',
    daysLeftToRecover,
  };
};

// Shown to the customer in the confirmation modal BEFORE they deactivate,
// so they know what's still in flight on their account.
export const getDeactivationWarnings = async (customerId) => {
  const [[orderRow]] = await db.query(
    `SELECT COUNT(*) AS cnt FROM orders WHERE customer_id = ? AND order_status NOT IN ('Delivered', 'Cancelled')`,
    [customerId]
  );
  const [[dealRow]] = await db.query(
    `SELECT COUNT(*) AS cnt FROM campaign_hold ch
     JOIN campaign c ON c.id = ch.campaign_id
     WHERE ch.customer_id = ? AND c.status IN ('ACTIVE', 'PAUSED')`,
    [customerId]
  );
  return {
    pendingOrders: orderRow.cnt,
    activeDeals:   dealRow.cnt,
  };
};

// Deactivating just sets a timestamp + clears active sessions. Reactivation
// is now an explicit action (see reactivateAccount below) rather than
// automatic on next login — the deactivated customer only sees a locked
// "Account Deactivated" screen until they press Activate.
export const deactivateAccount = async ({ customerId, password, reason = '' }) => {
  if (!password) { const e = new Error('Password is required to deactivate your account.'); e.status = 400; throw e; }

  await ensureDeactivationCols();

  const [rows] = await db.query('SELECT id, password FROM customer WHERE id = ?', [customerId]);
  const customer = rows[0];
  if (!customer) { const e = new Error('Account not found.'); e.status = 404; throw e; }

  const match = await bcrypt.compare(password, customer.password);
  if (!match) { const e = new Error('Incorrect password.'); e.status = 401; throw e; }

  await db.query('UPDATE customer SET deactivated_at = NOW(), deactivation_reason = ? WHERE id = ?', [reason || null, customerId]);
  // Log the customer out of every device, same as a normal logout would.
  await db.query('DELETE FROM customer_refresh_tokens WHERE customer_id = ?', [customerId]);

  return {
    message: `Your account has been deactivated. You have ${REACTIVATION_WINDOW_DAYS} days to log back in and reactivate it before it's permanently deleted.`,
  };
};

// Explicit reactivation — called only from the locked "Account Deactivated"
// screen when the customer presses "Activate My Account".
export const reactivateAccount = async ({ customerId }) => {
  await ensureDeactivationCols();
  const [rows] = await db.query('SELECT id, deactivated_at, permanently_deleted_at FROM customer WHERE id = ?', [customerId]);
  const customer = rows[0];
  if (!customer || customer.permanently_deleted_at) {
    const e = new Error('This account has been permanently deleted and cannot be reactivated.');
    e.status = 410;
    throw e;
  }
  await db.query('UPDATE customer SET deactivated_at = NULL WHERE id = ?', [customerId]);
  return { message: 'Your account has been reactivated. Welcome back!' };
};

// PERMANENT DELETION (after the 30-day window expires)
// The row is kept (orders/campaign history referencing this customer_id
// must remain intact) but every customer-facing PII field is scrubbed.
// This is checked lazily — see authService.login, which calls this the
// moment a permanently-expired account next attempts to log in.
export const anonymizeCustomerIfExpired = async (customer) => {
  if (!customer.deactivated_at || customer.permanently_deleted_at) return false;

  const deactivatedAt = new Date(customer.deactivated_at);
  const daysSince = (Date.now() - deactivatedAt.getTime()) / 86400000;
  if (daysSince < REACTIVATION_WINDOW_DAYS) return false;

  const cols = await getCols();
  const placeholderEmail = `deleted-user-${customer.id}@deleted.holdkart`;
  const setClauses = ['name = ?', 'email = ?', 'password = ?', 'permanently_deleted_at = NOW()'];
  const values     = ['Deleted User', placeholderEmail, await bcrypt.hash(uuidLikeToken(), BCRYPT_ROUNDS_LOCAL)];

  if (cols.has('mobile'))        { setClauses.push('mobile = NULL'); }
  if (cols.has('phone'))         { setClauses.push('phone = NULL'); }
  if (cols.has('address'))       { setClauses.push('address = NULL'); }
  if (cols.has('city'))          { setClauses.push('city = NULL'); }
  if (cols.has('state'))         { setClauses.push('state = NULL'); }
  if (cols.has('pincode'))       { setClauses.push('pincode = NULL'); }
  if (cols.has('profile_image')) { setClauses.push('profile_image = NULL'); }

  values.push(customer.id);
  await db.query(`UPDATE customer SET ${setClauses.join(', ')} WHERE id = ?`, values);
  await db.query('DELETE FROM customer_refresh_tokens WHERE customer_id = ?', [customer.id]);
  return true;
};

const BCRYPT_ROUNDS_LOCAL = 10;
function uuidLikeToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);
}