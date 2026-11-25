'use strict';
// PostgreSQL connection pool + transaction helpers.
const { Pool } = require('pg');

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
