import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     process.env.DB_PORT     ? Number(process.env.DB_PORT) : 5432,
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME     || 'holdkart',
  max: 10,
});

// ── MySQL-compatibility query wrapper ───────────────────────────────────────
// The rest of the codebase was originally written against mysql2/promise
// and uses `?` positional placeholders plus `const [rows] = await db.query(...)`
// (mysql2 returns [rows, fields] for SELECT and [resultSetHeader] for
// INSERT/UPDATE/DELETE, where resultSetHeader has .insertId / .affectedRows).
// Rather than rewriting every call site for node-postgres's $1/$2 style and
// different result shape, this wrapper translates the SQL and mimics the
// same return shape, so `db.query(sql, params)` keeps working everywhere.

// Convert `?` placeholders to $1, $2... while ignoring `?` inside string literals.
function convertPlaceholders(sql) {
  let out = '';
  let count = 0;
  let inSingle = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'" ) inSingle = !inSingle;
    if (ch === '?' && !inSingle) {
      count += 1;
      out += '$' + count;
    } else {
      out += ch;
    }
  }
  return out;
}

const INSERT_RE = /^\s*INSERT\s+INTO\s+([a-zA-Z_][a-zA-Z0-9_]*)/i;

const query = async (sql, params = []) => {
  let text = convertPlaceholders(sql);
  const isInsert = INSERT_RE.test(text);
  const alreadyHasReturning = /RETURNING/i.test(text);

  if (isInsert && !alreadyHasReturning) {
    // Strip a single trailing semicolon (if present) then append RETURNING id
    // so we can emulate mysql2's `result.insertId`. Every table in this schema
    // uses `id` as its identity primary key.
    text = text.replace(/;\s*$/, '') + ' RETURNING id';
  }

  const result = await pool.query(text, params);
  const rows = result.rows;

  if (isInsert || /^\s*(UPDATE|DELETE)\b/i.test(text)) {
    const meta = {
      affectedRows: result.rowCount,
      insertId: isInsert && rows[0] ? rows[0].id : undefined,
    };
    return [meta, rows];
  }

  return [rows, result.fields];
};

export default { query, pool };