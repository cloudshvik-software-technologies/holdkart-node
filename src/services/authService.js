import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import db from '../config/db.js';
import { sendEmail, sendPasswordResetEmail, sendWelcomeEmail, sendPasswordChangedEmail } from '../config/email.js';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../config/jwt.js';
import { anonymizeCustomerIfExpired } from './profileService.js';

const BCRYPT_ROUNDS = 10;
const REFRESH_TTL_DAYS = 7;

const buildPayload = (c) => ({ id: c.id, name: c.name, email: c.email });

/* Check once which optional columns exist in the customer table */
let _colCache = null;
async function getCustomerCols() {
  if (_colCache) return _colCache;
  const [rows] = await db.query('SHOW COLUMNS FROM customer');
  _colCache = new Set(rows.map(r => r.Field));
  return _colCache;
}

export const register = async ({ name, email, mobile, password }) => {
  const [exist] = await db.query('SELECT id FROM customer WHERE email = ?', [email]);
  if (exist.length) { const e = new Error('Email already registered.'); e.status = 409; throw e; }

  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const cols = await getCustomerCols();

  /* Build INSERT dynamically based on what columns actually exist */
  const fields = ['name', 'email', 'password'];
  const values = [name, email, hash];

  if (cols.has('mobile') && mobile) {
    fields.push('mobile');
    values.push(mobile);
  }

  await db.query(
    `INSERT INTO customer (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`,
    values
  );

  try {
    await sendWelcomeEmail(email, name);
  } catch {}

  return { message: 'Registration successful. You can now log in.' };
};

export const login = async ({ email, password }) => {
  const cols = await getCustomerCols();

  /* Login by email only — or also by mobile if that column exists */
  let rows;
  if (cols.has('mobile')) {
    [rows] = await db.query('SELECT * FROM customer WHERE email = ? OR mobile = ?', [email, email]);
  } else {
    [rows] = await db.query('SELECT * FROM customer WHERE email = ?', [email]);
  }

  const customer = rows[0];
  if (!customer) { const e = new Error('No account found with this email.'); e.status = 401; throw e; }

  const match = await bcrypt.compare(password, customer.password);
  if (!match) { const e = new Error('Incorrect password.'); e.status = 401; throw e; }

  const activeVal = customer.active ?? 1;
  if (!activeVal) { const e = new Error('Account suspended. Contact support.'); e.status = 403; throw e; }

  // PERMANENT DELETION CHECK (lazy — runs the moment an expired account
  // next tries to log in). If 30+ days have passed since deactivation,
  // the account's PII is scrubbed for good and login is refused.
  // NOTE: this only fires on a login attempt; an account that's never
  // logged into again stays deactivated-but-recoverable indefinitely in
  // the DB. For guaranteed same-day expiry regardless of login activity,
  // pair this with a scheduled job calling the same helper.
  const wasAnonymized = await anonymizeCustomerIfExpired(customer);
  if (wasAnonymized) {
    const e = new Error('This account has been permanently deleted.');
    e.status = 410;
    throw e;
  }

  // DEACTIVATED BUT STILL RECOVERABLE: do NOT auto-reactivate on login.
  // The customer must explicitly press "Activate My Account" on the
  // locked screen (see profileService.reactivateAccount). We still issue
  // tokens here so the frontend can call that authenticated endpoint.
  const deactivated   = !!customer.deactivated_at;
  const deactivatedAt = customer.deactivated_at || null;

  const accessToken  = signAccessToken(buildPayload(customer));
  const refreshToken = signRefreshToken({ id: customer.id });
  const expiresAt    = new Date(Date.now() + REFRESH_TTL_DAYS * 86400000);

  await db.query(
    'INSERT INTO customer_refresh_tokens (id, customer_id, token, expires_at) VALUES (?, ?, ?, ?)',
    [uuidv4(), customer.id, refreshToken, expiresAt]
  );

  return {
    message: 'Login successful',
    token: accessToken,
    refreshToken,
    customerId: customer.id,
    customer: {
      id: customer.id,
      name: customer.name,
      email: customer.email,
      mobile: customer.mobile || null,
      profileImage: customer.profile_image || null,
      deactivated: deactivated,
      deactivatedAt: deactivatedAt,
    },
  };
};

export const refresh = async ({ refreshToken }) => {
  if (!refreshToken) { const e = new Error('No refresh token'); e.status = 401; throw e; }
  const decoded = verifyRefreshToken(refreshToken);
  const [rows] = await db.query(
    'SELECT * FROM customer_refresh_tokens WHERE token = ? AND customer_id = ? AND expires_at > NOW()',
    [refreshToken, decoded.id]
  );
  if (!rows.length) { const e = new Error('Invalid or expired refresh token'); e.status = 401; throw e; }
  const [crows] = await db.query('SELECT * FROM customer WHERE id = ?', [decoded.id]);
  if (!crows.length) { const e = new Error('Customer not found'); e.status = 401; throw e; }
  const token = signAccessToken(buildPayload(crows[0]));
  return { token };
};

export const forgotPassword = async ({ email }) => {
  const [rows] = await db.query('SELECT id FROM customer WHERE email = ?', [email]);

  // Always return the same message to avoid leaking whether an email is registered
  if (!rows.length) return { message: 'If registered, a reset link has been sent.' };

  const token = uuidv4();
  const expiry = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

  await db.query(
    'INSERT INTO customer_password_reset_token (email, token, expiry_date) VALUES (?, ?, ?)',
    [email, token, expiry]
  );

  const resetLink = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/reset-password?token=${token}`;

  try {
    await sendPasswordResetEmail(email, resetLink);
  } catch (err) {
    console.error('[forgotPassword] Email send failed:', err.message);
    // Do not expose email errors to the client
  }

  return { message: 'If registered, a reset link has been sent.' };
};

export const resetPassword = async ({ token, password }) => {
  const [rows] = await db.query('SELECT * FROM customer_password_reset_token WHERE token = ?', [token]);
  if (!rows.length) { const e = new Error('Invalid or expired token.'); e.status = 400; throw e; }
  if (new Date(rows[0].expiry_date) < new Date()) { const e = new Error('Token expired.'); e.status = 400; throw e; }
  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  await db.query('UPDATE customer SET password = ? WHERE email = ?', [hash, rows[0].email]);
  await db.query('DELETE FROM customer_password_reset_token WHERE token = ?', [token]);
  // Send password changed confirmation email
  try {
    const [crows] = await db.query('SELECT name, email FROM customer WHERE email = ?', [rows[0].email]);
    if (crows.length) await sendPasswordChangedEmail(crows[0].email, crows[0].name);
  } catch {}
  return { message: 'Password reset successfully.' };
};

export const logout = async ({ customerId }) => {
  if (customerId) {
    await db.query('DELETE FROM customer_refresh_tokens WHERE customer_id = ?', [customerId]);
  }
  return { message: 'Logged out' };
};