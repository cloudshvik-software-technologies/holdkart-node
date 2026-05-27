import db from '../config/db.js';

/* Columns that might or might not exist */
const ALL_OPTIONAL_COLS = ['mobile', 'phone', 'address', 'city', 'state', 'pincode', 'profile_image', 'active', 'created_date'];

let _colCache = null;

async function getCols() {
  if (_colCache) return _colCache;
  const [rows] = await db.query('SHOW COLUMNS FROM customer');
  _colCache = new Set(rows.map(r => r.Field));
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
    await db.query('ALTER TABLE customer ADD COLUMN IF NOT EXISTS profile_image LONGTEXT');
    invalidateColCache();
  }
  await db.query('UPDATE customer SET profile_image = ? WHERE id = ?', [imageUrl, customerId]);
  return { message: 'Profile image updated', imageUrl };
};