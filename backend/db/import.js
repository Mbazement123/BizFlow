'use strict';
// One-time import: copy every business's Google Sheets data into PostgreSQL.
//
// Prereqs (env):
//   DATABASE_URL                  - target PostgreSQL
//   GOOGLE_SERVICE_ACCOUNT_JSON   - service account with Editor on all business sheets
//   REGISTRY_SHEET_ID             - the spreadsheet with the "Businesses" registry sheet
//
// What it does:
//   - reads the "Businesses" registry sheet (as today)
//   - for each active business row, loads that sheet, and copies Sales and/or Services
//     tables into the PostgreSQL schema
//   - seeds sequences to continue after the highest existing ID (no duplicate IDs)
//
// Safe to re-run: it upserts by stable business (code,app) + row ID.
const { google } = require('googleapis');
const { withTransaction } = require('../src/db');
const { clean, phoneKey } = require('../src/util');

function credentials() {
  let raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '';
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set.');
  if (!raw.trim().startsWith('{')) raw = Buffer.from(raw, 'base64').toString('utf8');
  const c = JSON.parse(raw);
  c.private_key = String(c.private_key || '').replace(/\\n/g, '\n');
  return c;
}

const auth = new google.auth.GoogleAuth({ credentials: credentials(), scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
const sheets = google.sheets({ version: 'v4', auth });

async function readSheet(id) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: id, fields: 'sheets.properties' });
  const titles = (meta.data.sheets || []).map(s => s.properties.title);
  const res = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: id,
    ranges: titles.map(t => `'${t.replace(/'/g, "''")}'`),
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'SERIAL_NUMBER'
  });
  const out = {};
  titles.forEach((t, i) => {
    out[t] = (res.data.valueRanges[i] || {}).values || [];
  });
  return out;
}

// Convert a rows array (with header) into objects keyed by header name.
function toObjects(rows) {
  if (!rows || rows.length < 2) return [];
  const headers = rows[0].map(String);
  return rows.slice(1).filter(r => r.join('') !== '').map(r => {
    const o = {};
    headers.forEach((h, i) => { o[h] = r[i]; });
    return o;
  });
}

function num(v) { return Number(v) || 0; }
function nextAfter(rows, getter, re) {
  let max = 0;
  rows.forEach(r => {
    const m = re.exec(String(r || ''));
    if (m) max = Math.max(max, Number(m[1]));
  });
  return max + 1;
}

async function importBusiness(client, bizId, code, app, data) {
  if (app === 'SALES') return importSales(client, bizId, code, data);
  return importServices(client, bizId, code, data);
}

async function importSales(client, bizId, code, d) {
  const products = toObjects(d.Products || []);
  const customers = toObjects(d.Customers || []);
  const sales = toObjects(d.Sales || []);
  const saleItems = toObjects(d.SaleItems || []);
  const config = toObjects(d.Config || []);
  const expenses = toObjects(d.Expenses || []);
  const categories = toObjects(d.Categories || []);
  const running = toObjects(d.RunningExpenses || []);

  const insert = (sql, arr) => arr.forEach(p => client.query(sql, p).catch(() => {}));

  for (const p of products) {
    if (!p.ProductID) continue;
    await client.query(
      `INSERT INTO sales_products (business_id, product_id, name, category, cost_price, selling_price, stock, unit)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (business_id, product_id) DO NOTHING`,
      [bizId, String(p.ProductID), String(p.Name || ''), String(p.Category || ''), num(p.CostPrice), num(p.SellingPrice), num(p.Stock), String(p.Unit || 'pcs')]
    );
  }
  for (const c of customers) {
    if (!c.CustomerID) continue;
    await client.query(
      `INSERT INTO sales_customers (business_id, customer_id, name, phone, email, address, total_purchases, date_added)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (business_id, customer_id) DO NOTHING`,
      [bizId, String(c.CustomerID), String(c.Name || ''), String(c.Phone || ''), String(c.Email || ''), String(c.Address || ''), num(c.TotalPurchases), c.DateAdded || new Date()]
    );
  }
  let order = 0;
  for (const e of expenses) {
    if (!e.ExpenseID) continue;
    order += 1;
    await client.query(
      `INSERT INTO sales_expenses (business_id, expense_id, date, product_id, product_name, type, qty, unit_cost, total_cost, selling_price, qty_remaining, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (business_id, expense_id) DO NOTHING`,
      [bizId, String(e.ExpenseID), e.Date || new Date(), String(e.ProductID || ''), String(e.ProductName || ''), String(e.Type || 'New'), num(e.Qty), num(e.UnitCost), num(e.TotalCost), num(e.SellingPrice), num(e.QtyRemaining), order]
    );
  }
  for (const c of categories) {
    if (!c.CategoryID) continue;
    await client.query(
      `INSERT INTO sales_categories (business_id, category_id, name, type, active)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (business_id, category_id) DO NOTHING`,
      [bizId, String(c.CategoryID), String(c.Name || ''), String(c.Type || 'Product'), String(c.Active).toUpperCase() !== 'FALSE']
    );
  }
  for (const r of running) {
    if (!r.ExpenseID) continue;
    await client.query(
      `INSERT INTO sales_running_expenses (business_id, expense_id, date, category, description, amount, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (business_id, expense_id) DO NOTHING`,
      [bizId, String(r.ExpenseID), r.Date || new Date(), String(r.Category || ''), String(r.Description || ''), num(r.Amount), r.CreatedAt || new Date()]
    );
  }
  // Config (non-counter values)
  for (const c of config) {
    if (!c.Key) continue;
    await client.query(
      `INSERT INTO sales_config (business_id, key, value) VALUES ($1,$2,$3) ON CONFLICT (business_id, key) DO NOTHING`,
      [bizId, String(c.Key), String(c.Value == null ? '' : c.Value)]
    );
  }
  for (const s of sales) {
    if (!s.SaleID) continue;
    await client.query(
      `INSERT INTO sales_sales (business_id, sale_id, date, customer_id, customer_name, subtotal, discount, total, payment_method, items_json, receipt_id, receipt_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (business_id, sale_id) DO NOTHING`,
      [bizId, String(s.SaleID), s.Date || new Date(), String(s.CustomerID || ''), String(s.CustomerName || 'Walk-in'), num(s.Subtotal), num(s.Discount), num(s.Total), String(s.PaymentMethod || 'Cash'), s.ItemsJSON || '[]', String(s.ReceiptID || ''), String(s.ReceiptUrl || '')]
    );
  }
  for (const it of saleItems) {
    if (!it.SaleID) continue;
    await client.query(
      `INSERT INTO sales_sale_items (business_id, sale_id, product_id, product_name, qty, price, line_total, cost_price, profit)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
      [bizId, String(it.SaleID), String(it.ProductID || ''), String(it.ProductName || ''), num(it.Qty), num(it.Price), num(it.LineTotal), num(it.CostPrice), num(it.Profit)]
    );
  }

  // Seed per-business counters to continue after the highest existing ID.
  const bump = async (name, re, list, getter) => {
    const n = nextAfter(list, getter, re);
    if (n <= 1) return;
    await client.query(
      `INSERT INTO counters (business_id, name, value) VALUES ($1,$2,$3)
       ON CONFLICT (business_id, name) DO UPDATE SET value = GREATEST(counters.value, EXCLUDED.value)`,
      [bizId, name, n - 1]
    );
  };
  await bump('prd', /^prd(\d+)$/i, products, x => x.ProductID);
  await bump('cus', /^cus(\d+)$/i, customers, x => x.CustomerID);
  await bump('sal', /^sal(\d+)$/i, sales, x => x.SaleID);
  await bump('rec', /^rec(\d+)$/i, sales, x => x.ReceiptID);
  await bump('exp', /^exp(\d+)$/i, expenses, x => x.ExpenseID);
  await bump('cat', /^cat(\d+)$/i, categories, x => x.CategoryID);
  await bump('rex', /^rex(\d+)$/i, running, x => x.ExpenseID);
}

async function importServices(client, bizId, code, d) {
  const services = toObjects(d.Services || []);
  const customers = toObjects(d.Customers || []);
  const sales = toObjects(d.Sales || []);
  const saleItems = toObjects(d.SaleItems || []);
  const expenses = toObjects(d.Expenses || []);
  const settings = toObjects(d.Settings || []);
  const categories = toObjects(d.Categories || []);

  for (const s of services) {
    if (!s.ServiceID) continue;
    await client.query(
      `INSERT INTO svc_services (business_id, service_id, name, price, active)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (business_id, service_id) DO NOTHING`,
      [bizId, String(s.ServiceID), String(s.Name || ''), num(s.Price), String(s.Active || 'TRUE').toUpperCase() !== 'FALSE']
    );
  }
  for (const c of customers) {
    if (!c.CustomerID) continue;
    await client.query(
      `INSERT INTO svc_customers (business_id, customer_id, name, phone, address, notes, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (business_id, customer_id) DO NOTHING`,
      [bizId, String(c.CustomerID), String(c.Name || ''), String(c.Phone || ''), String(c.Address || ''), String(c.Notes || ''), c.CreatedAt || new Date()]
    );
  }
  for (const s of sales) {
    if (!s.SaleID) continue;
    await client.query(
      `INSERT INTO svc_sales (business_id, sale_id, receipt_no, date, customer_id, customer_name, customer_phone, subtotal, discount, total, payment_method, status, created_at, discount_percent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (business_id, sale_id) DO NOTHING`,
      [bizId, String(s.SaleID), String(s.ReceiptNo || ''), s.Date || new Date(), String(s.CustomerID || ''), String(s.CustomerName || ''), String(s.CustomerPhone || ''), num(s.Subtotal), num(s.DiscountPercent || s.Discount), num(s.Total), String(s.PaymentMethod || 'Cash'), String(s.Status || 'Completed'), s.CreatedAt || new Date(), num(s.DiscountPercent)]
    );
  }
  for (const it of saleItems) {
    if (!it.ItemID) continue;
    await client.query(
      `INSERT INTO svc_sale_items (business_id, item_id, sale_id, service_name, qty, unit_price, line_total)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (business_id, item_id) DO NOTHING`,
      [bizId, String(it.ItemID), String(it.SaleID), String(it.ServiceName || ''), num(it.Qty), num(it.UnitPrice), num(it.LineTotal)]
    );
  }
  for (const e of expenses) {
    if (!e.ExpenseID) continue;
    await client.query(
      `INSERT INTO svc_expenses (business_id, expense_id, date, category, description, amount, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (business_id, expense_id) DO NOTHING`,
      [bizId, String(e.ExpenseID), e.Date || new Date(), String(e.Category || 'General'), String(e.Description || ''), num(e.Amount), e.CreatedAt || new Date()]
    );
  }
  for (const [i, c] of categories.entries()) {
    if (!c.CategoryID) continue;
    await client.query(
      `INSERT INTO svc_categories (business_id, category_id, name, type, active)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (business_id, category_id) DO NOTHING`,
      [bizId, String(c.CategoryID), String(c.Name || ''), String(c.Type || 'Expense'), String(c.Active || 'TRUE').toUpperCase() !== 'FALSE']
    );
  }
  for (const s of settings) {
    if (!s.Key) continue;
    // skip ID-counter keys; they become sequences
    if (/^Next/.test(String(s.Key))) continue;
    await client.query(
      `INSERT INTO svc_settings (business_id, key, value) VALUES ($1,$2,$3) ON CONFLICT (business_id, key) DO NOTHING`,
      [bizId, String(s.Key), String(s.Value == null ? '' : s.Value)]
    );
  }

  const bump = async (name, re, list, getter) => {
    const n = nextAfter(list, getter, re);
    if (n <= 1) return;
    await client.query(
      `INSERT INTO counters (business_id, name, value) VALUES ($1,$2,$3)
       ON CONFLICT (business_id, name) DO UPDATE SET value = GREATEST(counters.value, EXCLUDED.value)`,
      [bizId, name, n - 1]
    );
  };
  await bump('svc', /^svc(\d+)$/i, services, x => x.ServiceID);
  await bump('cus', /^cus(\d+)$/i, customers, x => x.CustomerID);
  await bump('sls', /^sls(\d+)$/i, sales, x => x.SaleID);
  await bump('rec', /^rec(\d+)$/i, sales, x => x.ReceiptNo);
  await bump('exp', /^exp(\d+)$/i, expenses, x => x.ExpenseID);
  await bump('itm', /^itm(\d+)$/i, saleItems, x => x.ItemID);
  await bump('cat', /^cat(\d+)$/i, categories, x => x.CategoryID);
}

async function main() {
  const registryId = process.env.REGISTRY_SHEET_ID;
  if (!registryId) throw new Error('REGISTRY_SHEET_ID is not set.');
  const data = await readSheet(registryId);
  const regRows = toObjects(data.Businesses || data['Businesses'] || []);
  if (!regRows.length) throw new Error('Businesses sheet is empty or missing.');

  await withTransaction(async client => {
    for (const r of regRows) {
      const code = clean(r.BusinessCode);
      if (!code || !r.SheetID) continue;
      const active = String(r.Active || 'YES').trim().toUpperCase() !== 'NO';
      const app = String(r.App || 'SALES').trim().toUpperCase();
      const name = String(r.BusinessName || code);

      // upsert registry row
      const reg = await client.query(
        `INSERT INTO businesses (code, name, app, active) VALUES ($1,$2,$3,$4)
         ON CONFLICT (code, app) DO UPDATE SET name = EXCLUDED.name, active = EXCLUDED.active
         RETURNING id`,
        [code, name, app, active]
      );
      const bizId = reg.rows[0].id;
      console.log(`Importing ${code} (${app}) ...`);

      if (!active) { console.log('  skipped (inactive)'); continue; }

      let bizData;
      try {
        bizData = await readSheet(String(r.SheetID));
      } catch (e) {
        console.error('  FAILED to read sheet: ' + e.message);
        continue;
      }
      await importBusiness(client, bizId, code, app, bizData);
      console.log('  done');
    }
  });
  console.log('Import complete.');
}

const { close } = require('../src/db');
main().then(() => close()).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
