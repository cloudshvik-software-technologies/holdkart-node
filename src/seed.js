// set-customer-password.js
//
// Directly sets a customer's password in the database, bypassing the
// email/token reset flow. Uses the exact same bcryptjs settings
// (BCRYPT_ROUNDS = 10) as src/services/authService.js, so the resulting
// hash will work with the normal login endpoint.
//
// Usage:
//   node set-customer-password.js <email> <newPassword>
//
// Example:
//   node set-customer-password.js hathem@gmail.com "MyNewPass123!"
//
// Run this from inside your holdkart-node project root (it reuses your
// existing .env DB_HOST / DB_USER / DB_PASSWORD / DB_NAME, same as the
// app itself), or edit the pool config below directly.

import 'dotenv/config';
import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';

const BCRYPT_ROUNDS = 10; // must match authService.js

async function main() {
  const [, , email, newPassword] = process.argv;

  if (!email || !newPassword) {
    console.error('Usage: node set-customer-password.js <email> <newPassword>');
    process.exit(1);
  }
  if (newPassword.length < 8) {
    console.error('Password should be at least 8 characters.');
    process.exit(1);
  }

  const pool = mysql.createPool({
    host:     process.env.DB_HOST     || 'localhost',
    user:     process.env.DB_USER     || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME     || 'holdkart',
  });

  try {
    const [existing] = await pool.query(
      'SELECT id, name, email FROM customer WHERE email = ?',
      [email]
    );
    if (!existing.length) {
      console.error(`No customer found with email: ${email}`);
      process.exit(1);
    }

    const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    const [result] = await pool.query(
      'UPDATE customer SET password = ? WHERE email = ?',
      [hash, email]
    );

    if (result.affectedRows === 1) {
      console.log(`✅ Password updated for ${existing[0].name} <${existing[0].email}>`);
      console.log('They can now log in with the new password.');

      // Optional: invalidate any pending reset tokens for this email so an
      // old token can't also be used to change it again.
      await pool.query('DELETE FROM customer_password_reset_token WHERE email = ?', [email]);
    } else {
      console.error('Update did not affect any rows — nothing changed.');
    }
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});