'use strict';
// Applies db/schema.sql (idempotent) and optionally seeds the registry.
// Run: npm run migrate
const fs = require('fs');
const path = require('path');
const { withTransaction, query, close } = require('../src/db');

async function run() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Set it before migrating.');
    process.exit(1);
  }
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await withTransaction(async client => {
    await client.query(sql);
  });
  console.log('Schema applied successfully.');

  // Optional seed of the registry from BUSINESS_* env vars is handled elsewhere.
  await close();
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
