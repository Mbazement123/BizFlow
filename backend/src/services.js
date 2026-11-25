'use strict';
// SERVICES POS — a faithful port of Services.gs onto PostgreSQL.
// Identical rules: phone-as-unique customer ID, percentage discounts, sequential IDs
// (now database sequences), and the same return shapes.

const { withTransaction } = require('./db');
const { code, phoneKey, normalizePhone, round2, iso, esc, money } = require('./util');

const SVC_RECEIPT_FONT = 'Arial, Helvetica, sans-serif';

async function nextNumber(client, bizId, name) {
  const r = await client.query(
    `INSERT INTO counters (business_id, name, value) VALUES ($1, $2, 1)
     ON CONFLICT (business_id, name) DO UPDATE SET value = counters.value + 1
     RETURNING value`,
    [bizId, name]
  );
  return Number(r.rows[0].value);
}

async function getSettingsMap(client, bizId) {
  const r = await client.query('SELECT key, value FROM svc_settings WHERE business_id = $1', [bizId]);
  const map = {};
  r.rows.forEach(x => { map[x.key] = x.value; });
  return map;
}

async function setSetting(client, bizId, key, value) {
  await client.query(
    `INSERT INTO svc_settings (business_id, key, value) VALUES ($1,$2,$3)
     ON CONFLICT (business_id, key) DO UPDATE SET value = EXCLUDED.value`,
    [bizId, key, String(value == null ? '' : value)]
  );
}

// ---------------------------------------------------------------
// Settings + init
// ---------------------------------------------------------------

async function updateBusinessSettings(ctx, data) {
  return withTransaction(async client => {
    for (const k of ['BusinessName', 'Address', 'Phone', 'Currency', 'ReceiptFooter']) {
      if (data && k in data) await setSetting(client, ctx.bizId, k, data[k]);
    }
    return getSettingsMap(client, ctx.bizId);
  });
}

async function svc_getInitData(ctx) {
  const svc = await ctx.client.query(
    'SELECT service_id, name, price, active FROM svc_services WHERE business_id = $1 AND active = TRUE ORDER BY id',
    [ctx.bizId]
  );
  const services = svc.rows.map(s => ({ ServiceID: s.service_id, Name: s.name, Price: Number(s.price), Active: s.active }));
  const settings = await getSettingsMap(ctx.client, ctx.bizId);
  const cust = await ctx.client.query(
    'SELECT customer_id, name, phone, address, notes, created_at FROM svc_customers WHERE business_id = $1 ORDER BY created_at DESC LIMIT 50',
    [ctx.bizId]
  );
  const customers = cust.rows.map(c => ({
    CustomerID: c.customer_id, Name: c.name, Phone: c.phone, Address: c.address, Notes: c.notes, CreatedAt: iso(c.created_at)
  }));
  return { services, settings, customers, categories: await getCategories(ctx, 'Expense') };
}

// ---------------------------------------------------------------
// Categories
// ---------------------------------------------------------------

async function getCategories(ctx, type) {
  type = type || 'Expense';
  const r = await ctx.client.query(
    'SELECT category_id, name, type, active FROM svc_categories WHERE business_id = $1 AND type = $2 AND active = TRUE ORDER BY id',
    [ctx.bizId, type]
  );
  return r.rows.map(x => ({ CategoryID: x.category_id, Name: x.name, Type: x.type, Active: x.active }));
}

async function getAllCategories(ctx, type) {
  type = type || 'Expense';
  const r = await ctx.client.query(
    'SELECT category_id, name, type, active FROM svc_categories WHERE business_id = $1 AND type = $2 ORDER BY id',
    [ctx.bizId, type]
  );
  return r.rows.map(x => ({ CategoryID: x.category_id, Name: x.name, Type: x.type, Active: x.active }));
}

async function addCategory(ctx, data) {
  const name = (data && data.name || '').toString().trim();
  const type = (data && data.type) || 'Expense';
  if (!name) throw new Error('Category name is required.');
  return withTransaction(async client => {
    const clash = await client.query(
      'SELECT 1 FROM svc_categories WHERE business_id = $1 AND type = $2 AND lower(name) = lower($3)',
      [ctx.bizId, type, name]
    );
    if (clash.rows.length) throw new Error('That category already exists.');
    const id = code('CAT', await nextNumber(client, ctx.bizId, 'cat'));
    await client.query('INSERT INTO svc_categories (business_id, category_id, name, type, active) VALUES ($1,$2,$3,$4,TRUE)', [ctx.bizId, id, name, type]);
    return { CategoryID: id, Name: name, Type: type, Active: true };
  });
}

async function updateCategory(ctx, categoryId, data) {
  return withTransaction(async client => {
    const r = await client.query('SELECT id, name, type FROM svc_categories WHERE business_id = $1 AND category_id = $2', [ctx.bizId, categoryId]);
    if (!r.rows.length) throw new Error('Category not found.');
    const cur = r.rows[0];
    if (data && data.name !== undefined && data.name !== null) {
      const name = data.name.toString().trim();
      if (!name) throw new Error('Category name is required.');
      const clash = await client.query(
        'SELECT 1 FROM svc_categories WHERE business_id = $1 AND type = $2 AND lower(name) = lower($3) AND category_id <> $4',
        [ctx.bizId, cur.type, name, categoryId]
      );
      if (clash.rows.length) throw new Error('That category already exists.');
      await client.query('UPDATE svc_categories SET name = $1 WHERE id = $2', [name, cur.id]);
    }
    if (data && data.active !== undefined && data.active !== null) {
      await client.query('UPDATE svc_categories SET active = $1 WHERE id = $2', [!!data.active, cur.id]);
    }
    return true;
  });
}

// ---------------------------------------------------------------
// Services
// ---------------------------------------------------------------

async function getAllServices(ctx) {
  const r = await ctx.client.query('SELECT service_id, name, price, active FROM svc_services WHERE business_id = $1 ORDER BY id', [ctx.bizId]);
  return r.rows.map(x => ({ ServiceID: x.service_id, Name: x.name, Price: Number(x.price), Active: x.active }));
}

async function addService(ctx, data) {
  if (!data || !data.name || !data.name.toString().trim()) throw new Error('Service name is required.');
  return withTransaction(async client => {
    const id = code('SVC', await nextNumber(client, ctx.bizId, 'svc'));
    await client.query('INSERT INTO svc_services (business_id, service_id, name, price, active) VALUES ($1,$2,$3,$4,TRUE)',
      [ctx.bizId, id, data.name.toString().trim(), Number(data.price || 0)]);
    return { ServiceID: id, Name: data.name.toString().trim(), Price: Number(data.price || 0), Active: true };
  });
}

async function updateService(ctx, serviceId, data) {
  return withTransaction(async client => {
    const r = await client.query('SELECT id FROM svc_services WHERE business_id = $1 AND service_id = $2', [ctx.bizId, serviceId]);
    if (!r.rows.length) throw new Error('Service not found.');
    if (data && data.name !== undefined && data.name !== null) {
      await client.query('UPDATE svc_services SET name = $1 WHERE id = $2', [data.name, r.rows[0].id]);
    }
    if (data && data.price !== undefined && data.price !== null) {
      await client.query('UPDATE svc_services SET price = $1 WHERE id = $2', [Number(data.price), r.rows[0].id]);
    }
    if (data && data.active !== undefined && data.active !== null) {
      await client.query('UPDATE svc_services SET active = $1 WHERE id = $2', [!!data.active, r.rows[0].id]);
    }
    return true;
  });
}

// ---------------------------------------------------------------
// Customers
// ---------------------------------------------------------------

async function findCustomerByPhone(ctx, phone) {
  const key = phoneKey(phone);
  if (!key) return null;
  const r = await ctx.client.query('SELECT customer_id, name, phone, address, notes, created_at FROM svc_customers WHERE business_id = $1', [ctx.bizId]);
  const match = r.rows.find(c => phoneKey(c.phone) === key);
  if (!match) return null;
  return { CustomerID: match.customer_id, Name: match.name, Phone: match.phone, Address: match.address, Notes: match.notes, CreatedAt: iso(match.created_at) };
}

async function searchCustomers(ctx, queryStr) {
  if (!queryStr) return [];
  queryStr = queryStr.toString().toLowerCase().trim();
  const qDigits = normalizePhone(queryStr);
  const r = await ctx.client.query('SELECT customer_id, name, phone, address, notes, created_at FROM svc_customers WHERE business_id = $1 ORDER BY created_at DESC', [ctx.bizId]);
  return r.rows
    .filter(c =>
      (c.name && c.name.toString().toLowerCase().includes(queryStr)) ||
      (qDigits.length >= 3 && normalizePhone(c.phone).includes(qDigits)))
    .slice(0, 20)
    .map(c => ({ CustomerID: c.customer_id, Name: c.name, Phone: c.phone, Address: c.address, Notes: c.notes, CreatedAt: iso(c.created_at) }));
}

async function addCustomerUnlocked(client, bizId, data) {
  const phone = (data.phone || '').toString().trim();
  if (!phoneKey(phone)) throw new Error("A phone number is required — it is the customer's unique ID.");
  const all = await client.query('SELECT customer_id, name, phone, address, notes, created_at FROM svc_customers WHERE business_id = $1', [bizId]);
  const existing = all.rows.find(c => phoneKey(c.phone) === phoneKey(phone));
  if (existing) {
    return { CustomerID: existing.customer_id, Name: existing.name, Phone: existing.phone, Address: existing.address, Notes: existing.notes, CreatedAt: iso(existing.created_at), Existing: true };
  }
  const id = code('CUS', await nextNumber(client, bizId, 'cus'));
  await client.query(
    'INSERT INTO svc_customers (business_id, customer_id, name, phone, address, notes, created_at) VALUES ($1,$2,$3,$4,$5,$6,now())',
    [bizId, id, data.name || '', phone, data.address || '', data.notes || '']
  );
  return { CustomerID: id, Name: data.name || '', Phone: phone, Address: data.address || '', Notes: data.notes || '', CreatedAt: iso(new Date()), Existing: false };
}

async function svc_addCustomer(ctx, data) {
  return withTransaction(async client => addCustomerUnlocked(client, ctx.bizId, data));
}

async function getCustomersWithSpend(ctx) {
  const r = await ctx.client.query(
    `SELECT c.customer_id, c.name, c.phone, c.address,
            COALESCE(SUM(s.total), 0)::numeric AS spent, COUNT(s.id)::int AS visits
     FROM svc_customers c
     LEFT JOIN svc_sales s ON s.business_id = c.business_id AND s.customer_id = c.customer_id
     WHERE c.business_id = $1
     GROUP BY c.id, c.customer_id, c.name, c.phone, c.address
     ORDER BY spent DESC, lower(c.name)`,
    [ctx.bizId]
  );
  return r.rows.map(c => ({
    CustomerID: c.customer_id,
    Name: c.name,
    Phone: c.phone,
    Address: c.address,
    TotalSpent: Math.round(Number(c.spent) * 100) / 100,
    Visits: Number(c.visits)
  }));
}

async function getCustomerHistory(ctx, customerId) {
  const r = await ctx.client.query(
    'SELECT sale_id, receipt_no, date, customer_id, customer_name, customer_phone, subtotal, discount, total, payment_method, status, discount_percent FROM svc_sales WHERE business_id = $1 AND customer_id = $2 ORDER BY date DESC',
    [ctx.bizId, customerId]
  );
  return r.rows.map(s => ({ SaleID: s.sale_id, ReceiptNo: s.receipt_no, Date: iso(s.date), CustomerID: s.customer_id, CustomerName: s.customer_name, CustomerPhone: s.customer_phone, Subtotal: Number(s.subtotal), Discount: Number(s.discount), Total: Number(s.total), PaymentMethod: s.payment_method, Status: s.status, DiscountPercent: Number(s.discount_percent) }));
}

// ---------------------------------------------------------------
// Sales
// ---------------------------------------------------------------

async function recordSale(ctx, saleData) {
  return withTransaction(async client => {
    let customerId = (saleData && saleData.customerId) || '';
    let customerName = (saleData && saleData.customerName) || '';
    let customerPhone = (saleData && saleData.customerPhone) || '';

    if (!customerId && saleData && saleData.newCustomer && saleData.newCustomer.name) {
      const cust = await addCustomerUnlocked(client, ctx.bizId, saleData.newCustomer);
      customerId = cust.CustomerID;
      customerName = cust.Name;
      customerPhone = cust.Phone;
    }

    const items = (saleData && saleData.items) || [];
    if (items.length === 0) throw new Error('No services added to this sale.');

    let subtotal = 0;
    items.forEach(it => {
      it.lineTotal = round2(Number(it.qty) * Number(it.unitPrice));
      subtotal += it.lineTotal;
    });
    subtotal = round2(subtotal);

    let discountPercent = Number((saleData && saleData.discountPercent) || 0);
    if (isNaN(discountPercent) || discountPercent < 0) discountPercent = 0;
    if (discountPercent > 100) discountPercent = 100;
    const discount = Math.round(subtotal * discountPercent) / 100;
    const total = Math.max(subtotal - discount, 0);

    const saleId = code('SLS', await nextNumber(client, ctx.bizId, 'sls'));
    const receiptNo = code('REC', await nextNumber(client, ctx.bizId, 'rec'));

    await client.query(
      `INSERT INTO svc_sales (business_id, sale_id, receipt_no, date, customer_id, customer_name, customer_phone, subtotal, discount, total, payment_method, status, created_at, discount_percent)
       VALUES ($1,$2,$3,now(),$4,$5,$6,$7,$8,$9,$10,'Completed',now(),$11)`,
      [ctx.bizId, saleId, receiptNo, customerId, customerName, customerPhone, subtotal, discountPercent, total, (saleData && saleData.paymentMethod) || 'Cash', discountPercent]
    );

    for (const it of items) {
      const itemId = code('ITM', await nextNumber(client, ctx.bizId, 'itm'));
      await client.query(
        'INSERT INTO svc_sale_items (business_id, item_id, sale_id, service_name, qty, unit_price, line_total) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [ctx.bizId, itemId, saleId, it.serviceName, it.qty, it.unitPrice, it.lineTotal]
      );
    }

    const result = {
      saleId, receiptNo,
      date: iso(new Date()),
      customerName, customerPhone,
      items,
      subtotal, discount, discountPercent, total,
      paymentMethod: (saleData && saleData.paymentMethod) || 'Cash'
    };
    result.receiptHtml = buildReceiptHtml(toReceiptSale(result), await getSettingsMap(client, ctx.bizId), ctx.tz);
    return result;
  });
}

async function getReceipt(ctx, saleId) {
  const sale = (await ctx.client.query('SELECT * FROM svc_sales WHERE business_id = $1 AND sale_id = $2', [ctx.bizId, saleId])).rows[0];
  if (!sale) throw new Error('Receipt not found.');
  const items = (await ctx.client.query('SELECT * FROM svc_sale_items WHERE business_id = $1 AND sale_id = $2 ORDER BY id', [ctx.bizId, saleId])).rows;
  const settings = await getSettingsMap(ctx.client, ctx.bizId);
  const subtotal = Number(sale.subtotal) || 0;
  const total = Number(sale.total) || 0;
  const discountAmt = Math.max(Math.round((subtotal - total) * 100) / 100, 0);
  const discountPct = Number(sale.discount_percent) || (subtotal > 0 ? Math.round(discountAmt / subtotal * 10000) / 100 : 0);
  return {
    saleId: sale.sale_id,
    receiptNo: sale.receipt_no,
    date: iso(sale.date),
    customerName: sale.customer_name,
    customerPhone: sale.customer_phone,
    items: items.map(it => ({ serviceName: it.service_name, qty: Number(it.qty), unitPrice: Number(it.unit_price), lineTotal: Number(it.line_total) })),
    subtotal, discount: discountAmt, discountPercent: discountPct, total,
    paymentMethod: sale.payment_method,
    business: settings
  };
}

async function getRecentSales(ctx, limit) {
  limit = limit || 20;
  const r = await ctx.client.query(
    'SELECT * FROM svc_sales WHERE business_id = $1 ORDER BY date DESC LIMIT $2',
    [ctx.bizId, Math.min(Number(limit), 1000)]
  );
  return r.rows.map(s => ({ saleId: s.sale_id, receiptNo: s.receipt_no, date: iso(s.date), customerName: s.customer_name, total: Number(s.total), paymentMethod: s.payment_method }));
}

// ---------------------------------------------------------------
// Receipt HTML / PDF
// ---------------------------------------------------------------

function toReceiptSale(r) {
  return {
    receiptId: r.receiptNo,
    date: r.date,
    customerName: r.customerName,
    customerPhone: r.customerPhone,
    paymentMethod: r.paymentMethod,
    subtotal: r.subtotal,
    discount: r.discount,
    discountPercent: r.discountPercent,
    total: r.total,
    items: (r.items || []).map(it => ({ name: it.serviceName, qty: it.qty, price: it.unitPrice }))
  };
}

function svc_getConfig(settings) {
  const s = Object.assign({}, settings);
  s.Footer = s.ReceiptFooter;
  return s;
}

function buildReceiptHtml(sale, settings, tzLabel) {
  const config = svc_getConfig(settings);
  const currency = config.Currency || '';
  const when = new Date(sale.date).toLocaleString('en-GB', { timeZone: tzLabel, day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const itemsHtml = sale.items.map(it => {
    const line = Number(it.qty) * Number(it.price);
    return '<table class="item">' +
      '<tr><td colspan="2" class="item-name">' + esc(it.name) + '</td></tr>' +
      '<tr><td class="item-calc">' + esc(it.qty) + ' &times; ' + money(it.price, currency) + '</td>' +
      '<td class="amt">' + money(line, currency) + '</td></tr>' +
      '</table>';
  }).join('');
  const css = [
    '@page{margin:8mm}',
    'body{font-family:' + SVC_RECEIPT_FONT + ';font-size:13px;line-height:1.5;color:#111;max-width:300px;margin:0 auto;padding:16px 14px;}',
    'table{width:100%;border-collapse:collapse;}',
    'h2{font-size:20px;margin:0 0 6px;text-align:center;}',
    '.sub{font-size:12px;color:#444;text-align:center;margin:2px 0;}',
    '.divider{border-top:1px dashed #888;margin:14px 0;}',
    '.meta td{padding:4px 0;font-size:12.5px;vertical-align:top;}',
    '.meta td.k{color:#555;width:38%;}',
    '.meta td.v{text-align:right;font-weight:bold;}',
    '.item{border-bottom:1px dotted #bbb;margin-bottom:2px;}',
    '.item td{padding:3px 0;}',
    '.item-name{font-weight:bold;font-size:13.5px;padding-top:8px !important;}',
    '.item-calc{font-size:12.5px;color:#333;padding-bottom:8px !important;}',
    '.amt{text-align:right;font-size:13px;padding-bottom:8px !important;}',
    '.totals td{padding:4px 0;font-size:13px;}',
    '.totals td.amt{padding-bottom:4px !important;}',
    '.grand td{font-size:17px;font-weight:bold;border-top:2px solid #111;padding-top:10px;}',
    '.footer{text-align:center;font-size:12px;color:#444;margin-top:20px;line-height:1.6;}'
  ].join('');
  return (
    '<html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<style>' + css + '</style></head><body>' +
    '<h2>' + esc(config.BusinessName || 'Sales Receipt') + '</h2>' +
    (config.Address ? '<div class="sub">' + esc(config.Address) + '</div>' : '') +
    (config.Phone ? '<div class="sub">' + esc(config.Phone) + '</div>' : '') +
    '<div class="divider"></div>' +
    '<table class="meta">' +
      '<tr><td class="k">Receipt No</td><td class="v">' + esc(sale.receiptId) + '</td></tr>' +
      '<tr><td class="k">Date</td><td class="v">' + esc(when) + '</td></tr>' +
      '<tr><td class="k">Customer</td><td class="v">' + esc(sale.customerName || 'Walk-in') + '</td></tr>' +
      (sale.customerPhone ? '<tr><td class="k">Phone</td><td class="v">' + esc(sale.customerPhone) + '</td></tr>' : '') +
      '<tr><td class="k">Payment</td><td class="v">' + esc(sale.paymentMethod) + '</td></tr>' +
    '</table>' +
    '<div class="divider"></div>' +
    itemsHtml +
    '<div class="divider"></div>' +
    '<table class="totals">' +
      '<tr><td>Subtotal</td><td class="amt">' + money(sale.subtotal, currency) + '</td></tr>' +
      (Number(sale.discount) ? '<tr><td>Discount' + (Number(sale.discountPercent) ? ' (' + Number(sale.discountPercent) + '%)' : '') + '</td><td class="amt">-' + money(sale.discount, currency) + '</td></tr>' : '') +
      '<tr class="grand"><td>TOTAL</td><td class="amt">' + money(sale.total, currency) + '</td></tr>' +
    '</table>' +
    '<div class="footer">' + esc(config.Footer || 'Thank you!') + '</div>' +
    '</body></html>'
  );
}

async function svc_getReceiptHtml(ctx, saleId) {
  const r = await getReceipt(ctx, saleId);
  const settings = await getSettingsMap(ctx.client, ctx.bizId);
  return buildReceiptHtml(toReceiptSale(r), settings, ctx.tz);
}

async function getReceiptPdf(ctx, saleId) {
  const r = await getReceipt(ctx, saleId);
  const settings = await getSettingsMap(ctx.client, ctx.bizId);
  const html = buildReceiptHtml(toReceiptSale(r), settings, ctx.tz);
  return { name: r.receiptNo + '.pdf', __pdf: { sale: toReceiptSale(r), config: svc_getConfig(settings), html } };
}

// ---------------------------------------------------------------
// Expenses + reports
// ---------------------------------------------------------------

async function addExpense(ctx, data) {
  return withTransaction(async client => {
    const id = code('EXP', await nextNumber(client, ctx.bizId, 'exp'));
    const date = (data && data.date) ? new Date(data.date) : new Date();
    await client.query(
      'INSERT INTO svc_expenses (business_id, expense_id, date, category, description, amount, created_at) VALUES ($1,$2,$3,$4,$5,$6,now())',
      [ctx.bizId, id, date, (data && data.category) || 'General', (data && data.description) || '', Number((data && data.amount) || 0)]
    );
    return { ExpenseID: id, Date: iso(date), Category: (data && data.category) || 'General', Description: (data && data.description) || '', Amount: Number((data && data.amount) || 0) };
  });
}

async function getExpenses(ctx, startDate, endDate) {
  let sql = 'SELECT * FROM svc_expenses WHERE business_id = $1';
  const params = [ctx.bizId];
  if (startDate) { params.push(new Date(startDate)); sql += ' AND date >= $' + params.length; }
  if (endDate) {
    const e = new Date(endDate); e.setHours(23, 59, 59, 999);
    params.push(e); sql += ' AND date <= $' + params.length;
  }
  sql += ' ORDER BY date DESC';
  const r = await ctx.client.query(sql, params);
  return r.rows.map(e => ({ ExpenseID: e.expense_id, Date: iso(e.date), Category: e.category, Description: e.description, Amount: Number(e.amount), CreatedAt: iso(e.created_at) }));
}

async function getReportSummary(ctx, from, to) {
  const parse = (str, addDays) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || ''));
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + addDays) : null;
  };
  const start = parse(from, 0);
  const end = parse(to, 1);
  if (start && end && start >= end) throw new Error('"From" date is after "To" date.');

  let salesSql = 'SELECT * FROM svc_sales WHERE business_id = $1';
  let expSql = 'SELECT * FROM svc_expenses WHERE business_id = $1';
  const salesParams = [ctx.bizId];
  const expParams = [ctx.bizId];
  if (start) { salesParams.push(start); expParams.push(start); const i = salesParams.length; salesSql += ' AND date >= $' + i; expSql += ' AND date >= $' + i; }
  if (end) { salesParams.push(end); expParams.push(end); const i = salesParams.length; salesSql += ' AND date < $' + i; expSql += ' AND date < $' + i; }
  salesSql += ' ORDER BY date DESC';
  expSql += ' ORDER BY date DESC';

  const sales = (await ctx.client.query(salesSql, salesParams)).rows;
  const expenses = (await ctx.client.query(expSql, expParams)).rows;

  const totalSales = round2(sales.reduce((sum, s) => sum + Number(s.total || 0), 0));
  const totalExpenses = round2(expenses.reduce((sum, e) => sum + Number(e.amount || 0), 0));

  const salesOut = sales.slice(0, 200).map(s => ({ SaleID: s.sale_id, ReceiptNo: s.receipt_no, Date: iso(s.date), CustomerID: s.customer_id, CustomerName: s.customer_name, Subtotal: Number(s.subtotal), Discount: Number(s.discount), Total: Number(s.total), PaymentMethod: s.payment_method, Status: s.status }));

  return {
    from: from || '',
    to: to || '',
    salesCount: sales.length,
    totalSales,
    totalExpenses,
    net: round2(totalSales - totalExpenses),
    sales: salesOut,
    truncated: sales.length > 200
  };
}

module.exports = {
  updateBusinessSettings, svc_getInitData,
  getCategories, getAllCategories, addCategory, updateCategory,
  getAllServices, addService, updateService,
  findCustomerByPhone, searchCustomers, svc_addCustomer, getCustomersWithSpend, getCustomerHistory,
  recordSale, getReceipt, getRecentSales, svc_getReceiptHtml, getReceiptPdf,
  addExpense, getExpenses, getReportSummary
};
