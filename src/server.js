import 'dotenv/config';
  import app from './app.js';
  import db from './config/db.js';
  import { startInvoiceEmailPoller } from './services/orderService.js';

  const PORT = process.env.PORT || 8081;

  (async () => {
    // ── Test DB connection before starting ──────────────────────────────────
    try {
      const [rows] = await db.query('SELECT 1');
      console.log('PostgreSQL connected ');
    } catch (err) {
      console.error('\n❌  PostgreSQL connection failed!');
      console.error('   Error:', err.message);
      console.error('\n   ➜  Open holdkart-customer-node/.env and set:');
      console.error('        DB_HOST     = your Postgres host (default: localhost)');
      console.error('        DB_PORT     = your Postgres port (default: 5432)');
      console.error('        DB_USER     = your Postgres username (default: postgres)');
      console.error('        DB_PASSWORD = your Postgres password');
      console.error('        DB_NAME     = holdkart');
      console.error('\n   Then restart the server.\n');
      process.exit(1);
    }

    app.listen(PORT, () => {
      console.log(`Server Connected on PORT ${PORT}`);
      // console.log(`    API prefix: /api/customer`);
      startInvoiceEmailPoller();
    });
  })();