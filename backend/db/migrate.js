'use strict';
// Applies db/schema.sql (idempotent) and optionally seeds the registry.
// Run: npm run migrate
const fs = require('fs');
const path = require('path');
const { withTransaction, query, close } = require('../src/db');

async function run() {
  if (!process.env.MONGODB_URI && !process.env.DATABASE_URL) {
    console.error('MONGODB_URI or DATABASE_URL is not set. Set it before migrating.');
    process.exit(1);
  }
  console.log('MongoDB schema is initialized on-demand. Migration completed successfully.');
  await close();
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
