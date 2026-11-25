'use strict';
// One-time setup of a new Services business (replaces setupSpreadsheet()).
// Ensures a registry row exists and seeds default services + settings + categories.
const { withTransaction, query } = require('./db');
const { clean, code } = require('./util');

const DEFAULT_SERVICES = [
  ['SVC0001', 'Standard Service', 2000],
  ['SVC0002', 'Express Service', 3500],
  ['SVC0003', 'Consultation', 1500],
  ['SVC0004', 'Home Visit', 5000],
  ['SVC0005', 'Per-item Service', 500]
];

const DEFAULT_SETTINGS = [
  ['BusinessName', 'Your Business'],
  ['Address', '123 Main Street, Lagos'],
  ['Phone', '0800-000-0000'],
  ['ReceiptFooter', 'Thank you for your patronage!'],
  ['Currency', '\u20A6']
];

const DEFAULT_CATEGORIES = ['Detergent & Supplies', 'Electricity / Utilities', 'Rent', 'Staff Wages',
  'Equipment / Maintenance', 'Transport', 'Other'];

async function setupServices(code, name) {
  code = clean(code).toUpperCase();
  if (!code) throw new Error('Business code is required.');
  return withTransaction(async client => {
    // Ensure a SERVICES registry row
    let biz = await client.query('SELECT id FROM businesses WHERE code = $1 AND app = $2', [code, 'SERVICES']);
    let bizId;
    if (!biz.rows.length) {
      const ins = await client.query(
        'INSERT INTO businesses (code, name, app, active) VALUES ($1,$2,$3,TRUE) RETURNING id',
        [code, name || code, 'SERVICES']
      );
      bizId = ins.rows[0].id;
    } else {
      bizId = biz.rows[0].id;
    }

    // Seed settings (only if missing)
    for (const [k, v] of DEFAULT_SETTINGS) {
      await client.query(
        `INSERT INTO svc_settings (business_id, key, value) VALUES ($1,$2,$3)
         ON CONFLICT (business_id, key) DO NOTHING`,
        [bizId, k, v]
      );
    }

    // Seed services (only if none exist)
    const svcCount = await client.query('SELECT COUNT(*)::int AS n FROM svc_services WHERE business_id = $1', [bizId]);
    if (svcCount.rows[0].n === 0) {
      for (const [sid, nm, price] of DEFAULT_SERVICES) {
        await client.query(
          'INSERT INTO svc_services (business_id, service_id, name, price, active) VALUES ($1,$2,$3,$4,TRUE) ON CONFLICT (business_id, service_id) DO NOTHING',
          [bizId, sid, nm, price]
        );
      }
    }

    // Seed categories (only if none exist)
    const catCount = await client.query('SELECT COUNT(*)::int AS n FROM svc_categories WHERE business_id = $1', [bizId]);
    if (catCount.rows[0].n === 0) {
      let i = 0;
      for (const nm of DEFAULT_CATEGORIES) {
        i += 1;
        const catId = 'CAT' + String(i).padStart(4, '0');
        await client.query(
          'INSERT INTO svc_categories (business_id, category_id, name, type, active) VALUES ($1,$2,$3,$4,TRUE) ON CONFLICT (business_id, category_id) DO NOTHING',
          [bizId, catId, nm, 'Expense']
        );
      }
    }

    // Keep the per-business counters ahead of the seeded hard-coded IDs so future
    // addService()/addCategory() never collide (SVC0001.. and CAT0001..).
    await bumpCounterToMax(client, bizId, 'svc', 'svc_services', 'service_id');
    await bumpCounterToMax(client, bizId, 'cat', 'svc_categories', 'category_id');

    return 'Setup complete.';
  });
}

// Raise counters(name) to the highest numeric suffix found in table.idColumn (e.g. SVC0007 -> 7).
async function bumpCounterToMax(client, bizId, name, table, idColumn) {
  const r = await client.query(`SELECT ${idColumn} AS id FROM ${table} WHERE business_id = $1`, [bizId]);
  let max = 0;
  r.rows.forEach(row => {
    const m = /(\d+)\s*$/.exec(String(row.id || ''));
    if (m) max = Math.max(max, Number(m[1]));
  });
  if (max <= 0) return;
  await client.query(
    `INSERT INTO counters (business_id, name, value) VALUES ($1,$2,$3)
     ON CONFLICT (business_id, name) DO UPDATE SET value = GREATEST(counters.value, EXCLUDED.value)`,
    [bizId, name, max]
  );
}

module.exports = { setupServices };
