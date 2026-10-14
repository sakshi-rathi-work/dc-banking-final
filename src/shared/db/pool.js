// src/shared/db/pool.js: PostgreSQL connection pool
const { Pool } = require('pg');

let pool = null;

function getPool(databaseUrl) {
  if (!pool) {
    const url = databaseUrl || process.env.DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL is not set');
    }
    pool = new Pool({
      connectionString: url,
      max: parseInt(process.env.PG_MAX_POOL || '10', 10),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000
    });

    pool.on('error', (err) => {
      // Unhandled error on idle client
      console.error(JSON.stringify({
        level: 'error',
        event: 'db.pool_error',
        error: err.message
      }));
    });
  }
  return pool;
}

async function query(text, params) {
  const p = getPool();
  return p.query(text, params);
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = {
  getPool,
  query,
  closePool
};
