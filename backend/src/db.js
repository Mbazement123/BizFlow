'use strict';
// PostgreSQL connection pool + transaction helpers.
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// Load a local .env file if it exists (development). On hosts like Render the
// variables come from the dashboard, so a missing .env is normal and never fatal.
(function loadEnvIfPresent() {
  const file = path.join(__dirname, '..', '.env');
  try {
    if (!fs.existsSync(file)) return;
    const text = fs.readFileSync(file, 'utf8');
    text.split(/\r?\n/).forEach(line => {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) return;                                  // skip blanks/comments
      if (line.trim().startsWith('#')) return;
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[m[1]] === undefined) process.env[m[1]] = val;  // don't override real env
    });
  } catch (_) { /* ignore */ }
})();

let pool = null;

function getPool() {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set.');
  pool = new Pool({
    connectionString: url,
    ssl: /sslmode=require|neon|supabase|railway/i.test(url) ? { rejectUnauthorized: false } : undefined,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 8000
  });
  pool.on('error', err => console.error('Unexpected PG pool error', err));
  return pool;
}

async function query(text, params) {
  return getPool().query(text, params);
}

// Run fn(client) inside a transaction; commits on success, rolls back on error.
async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

async function close() {
  if (pool) { await pool.end(); pool = null; }
}

module.exports = { getPool, query, withTransaction, close };
