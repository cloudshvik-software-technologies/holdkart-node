import 'dotenv/config';
import { Pool } from 'pg';

const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  max:      10,               // equivalent to mysql2's connectionLimit
  idleTimeoutMillis: 30000,
});

// ── mysql2-compatible query shim ────────────────────────────────────────────
// The whole codebase was written against mysql2/promise's API:
//   const [rows]  = await db.query('SELECT ... WHERE id = ?', [id]);
//   const [result] = await db.query('INSERT ... VALUES (?, ?)', [a, b]);
//   result.insertId / result.affectedRows
//
// Rather than touching every call site, this shim translates '?' placeholders
// to Postgres's $1, $2..., strips MySQL backtick identifier quoting, and
// reshapes pg's result object so existing destructuring/property access
// keeps working unchanged.
const toPgQuery = (sql) => {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`).replace(/`/g, '');
};

const isWriteStatement = (sql) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql);
const isInsertStatement = (sql) => /^\s*INSERT\b/i.test(sql);

const query = async (sql, params = []) => {
  const text = toPgQuery(sql);

  // For INSERT statements that don't already ask for RETURNING, add one so
  // we can populate `insertId` the way mysql2's ResultSetHeader does.
  // (Every table in this project uses a plain `id` primary key.)
  const needsReturning = isInsertStatement(sql) && !/returning/i.test(sql);
  const finalText = needsReturning ? `${text} RETURNING id` : text;

  const result = await pool.query(finalText, params);

  if (isWriteStatement(sql)) {
    const meta = {
      affectedRows: result.rowCount,
      insertId: needsReturning && result.rows[0] ? result.rows[0].id : undefined,
      rows: result.rows,
    };
    return [meta, undefined];
  }

  // SELECT / everything else: behave like mysql2, i.e. [rows, fields]
  return [result.rows, result.fields];
};

export default { query, pool };
