import db from '../config/db.js';

let _colCache = null;

async function getCols() {
  if (_colCache) return _colCache;
  const [rows] = await db.query(`SELECT column_name AS "Field" FROM information_schema.columns WHERE table_name = 'customer_address'`);
  _colCache = new Set(rows.map(r => r.Field));
  return _colCache;
}
const invalidateColCache = () => { _colCache = null; };

// customer_address already existed in the DB (id, address_line1, address_line2,
// city, state, pincode, customer_id) but had no receiver name/mobile, no
// label (Home/Work/Other), and no default flag. Add those lazily, same
// pattern used throughout profileService.js.
async function ensureCols() {
  let cols = await getCols();
  const wanted = {
    name:       'TEXT',
    mobile:     'VARCHAR(20)',
    label:      "VARCHAR(20) DEFAULT 'Home'",
    is_default: 'BOOLEAN DEFAULT FALSE',
  };
  for (const [col, ddl] of Object.entries(wanted)) {
    if (!cols.has(col)) {
      await db.query(`ALTER TABLE customer_address ADD COLUMN IF NOT EXISTS ${col} ${ddl}`);
      invalidateColCache();
      cols = await getCols();
    }
  }
  return cols;
}

const SELECT_COLS = 'id, customer_id, name, mobile, label, address_line1, address_line2, city, state, pincode, is_default';

export const listAddresses = async (customerId) => {
  await ensureCols();
  const [rows] = await db.query(
    `SELECT ${SELECT_COLS} FROM customer_address WHERE customer_id = ? ORDER BY is_default DESC, id DESC`,
    [customerId]
  );
  return rows;
};

const validate = ({ name, mobile, address_line1, city, state, pincode }) => {
  if (!name || !name.trim())          { const e = new Error('Receiver name is required.'); e.status = 400; throw e; }
  if (!mobile || !/^\d{10}$/.test(mobile)) { const e = new Error('A valid 10-digit mobile number is required.'); e.status = 400; throw e; }
  if (!address_line1 || !address_line1.trim()) { const e = new Error('Address is required.'); e.status = 400; throw e; }
  if (!city || !city.trim())          { const e = new Error('City is required.'); e.status = 400; throw e; }
  if (!state || !state.trim())        { const e = new Error('State is required.'); e.status = 400; throw e; }
  if (!pincode || !/^\d{6}$/.test(pincode)) { const e = new Error('A valid 6-digit pincode is required.'); e.status = 400; throw e; }
};

export const createAddress = async ({ customerId, name, mobile, label, address_line1, address_line2, city, state, pincode, is_default }) => {
  await ensureCols();
  validate({ name, mobile, address_line1, city, state, pincode });

  if (is_default) {
    await db.query('UPDATE customer_address SET is_default = FALSE WHERE customer_id = ?', [customerId]);
  }

  const [, rows] = await db.query(
    `INSERT INTO customer_address (customer_id, name, mobile, label, address_line1, address_line2, city, state, pincode, is_default)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${SELECT_COLS}`,
    [customerId, name, mobile, label || 'Home', address_line1, address_line2 || null, city, state, pincode, !!is_default]
  );
  return rows[0];
};

export const updateAddress = async ({ customerId, addressId, name, mobile, label, address_line1, address_line2, city, state, pincode, is_default }) => {
  await ensureCols();
  validate({ name, mobile, address_line1, city, state, pincode });

  const [existingRows] = await db.query('SELECT id FROM customer_address WHERE id = ? AND customer_id = ?', [addressId, customerId]);
  if (!existingRows[0]) { const e = new Error('Address not found.'); e.status = 404; throw e; }

  if (is_default) {
    await db.query('UPDATE customer_address SET is_default = FALSE WHERE customer_id = ?', [customerId]);
  }

  const [, rows] = await db.query(
    `UPDATE customer_address
     SET name = ?, mobile = ?, label = ?, address_line1 = ?, address_line2 = ?, city = ?, state = ?, pincode = ?, is_default = ?
     WHERE id = ? AND customer_id = ? RETURNING ${SELECT_COLS}`,
    [name, mobile, label || 'Home', address_line1, address_line2 || null, city, state, pincode, !!is_default, addressId, customerId]
  );
  return rows[0];
};

export const deleteAddress = async ({ customerId, addressId }) => {
  const [, rows] = await db.query('DELETE FROM customer_address WHERE id = ? AND customer_id = ? RETURNING id', [addressId, customerId]);
  if (!rows[0]) { const e = new Error('Address not found.'); e.status = 404; throw e; }
  return { message: 'Address deleted' };
};

export const setDefaultAddress = async ({ customerId, addressId }) => {
  await ensureCols();
  const [existingRows] = await db.query('SELECT id FROM customer_address WHERE id = ? AND customer_id = ?', [addressId, customerId]);
  if (!existingRows[0]) { const e = new Error('Address not found.'); e.status = 404; throw e; }

  await db.query('UPDATE customer_address SET is_default = FALSE WHERE customer_id = ?', [customerId]);
  const [, rows] = await db.query(
    `UPDATE customer_address SET is_default = TRUE WHERE id = ? AND customer_id = ? RETURNING ${SELECT_COLS}`,
    [addressId, customerId]
  );
  return rows[0];
};