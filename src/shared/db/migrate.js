// src/shared/db/migrate.js: Database Migration Runner
const fs = require('fs');
const path = require('path');
const { getPool } = require('./pool');

async function runMigrations(customPool) {
  const pool = customPool || getPool();
  const client = await pool.connect();

  try {
    // Ensure migrations table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    const migrationsDir = path.resolve(__dirname, '../../../db/migrations');
    if (!fs.existsSync(migrationsDir)) {
      throw new Error(`Migrations directory not found: ${migrationsDir}`);
    }

    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    const appliedRes = await client.query('SELECT name FROM schema_migrations');
    const appliedSet = new Set(appliedRes.rows.map(r => r.name));

    const newlyApplied = [];

    for (const file of files) {
      if (appliedSet.has(file)) {
        continue;
      }

      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf8');

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (name, applied_at) VALUES ($1, now())',
          [file]
        );
        await client.query('COMMIT');
        newlyApplied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        err.message = `Migration failed in ${file}: ${err.message}`;
        throw err;
      }
    }

    return newlyApplied;
  } finally {
    client.release();
  }
}

module.exports = {
  runMigrations
};
