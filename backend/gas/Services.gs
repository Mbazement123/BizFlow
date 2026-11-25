/**
 * SERVICES POS — backend (called through api() in Router.gs)
 * ---------------------------------------------------------------
 * Every Services business has its own spreadsheet, listed in the Businesses
 * registry with App = SERVICES. To build its tabs, run setupBusiness() from
 * Router.gs once (after putting the business code in it).
 *
 * If a business sheet was set up from an earlier version of this project,
 * use upgradeSettings() instead — it adds the new ID counters without
 * touching any data you already have.
 */

const SHEET_NAMES = {
  SERVICES: 'Services',
  CUSTOMERS: 'Customers',
  SALES: 'Sales',
  SALE_ITEMS: 'SaleItems',
  EXPENSES: 'Expenses',
  SETTINGS: 'Settings',
  CATEGORIES: 'Categories'
};

// The business's spreadsheet. While the web app is running this is the sheet
// picked by the business code; in the editor (setup functions) it falls back
// to this script's own bound spreadsheet.
function getSS() {
  return SS || SpreadsheetApp.getActiveSpreadsheet();
}

// ---------- One-time setup ----------

function setupSpreadsheet() {
  const ss = getSS();

  const sheetsConfig = {
    [SHEET_NAMES.SERVICES]: ['ServiceID', 'Name', 'Price', 'Active'],
    [SHEET_NAMES.CUSTOMERS]: ['CustomerID', 'Name', 'Phone', 'Address', 'Notes', 'CreatedAt'],
    [SHEET_NAMES.SALES]: ['SaleID', 'ReceiptNo', 'Date', 'CustomerID', 'CustomerName', 'CustomerPhone', 'Subtotal', 'Discount', 'Total', 'PaymentMethod', 'Status', 'CreatedAt', 'DiscountPercent'],
    [SHEET_NAMES.SALE_ITEMS]: ['ItemID', 'SaleID', 'ServiceName', 'Qty', 'UnitPrice', 'LineTotal'],
    [SHEET_NAMES.EXPENSES]: ['ExpenseID', 'Date', 'Category', 'Description', 'Amount', 'CreatedAt'],
    [SHEET_NAMES.SETTINGS]: ['Key', 'Value'],
    [SHEET_NAMES.CATEGORIES]: ['CategoryID', 'Name', 'Type', 'Active']
  };

  Object.keys(sheetsConfig).forEach(name => {
    let sheet = ss.getSheetByName(name);
    if (!sheet) sheet = ss.insertSheet(name);
    const headers = sheetsConfig[name];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  });

  const svcSheet = ss.getSheetByName(SHEET_NAMES.SERVICES);
  if (svcSheet.getLastRow() < 2) {
    const defaults = [
      ['SVC0001', 'Standard Service', 2000, true],
      ['SVC0002', 'Express Service', 3500, true],
      ['SVC0003', 'Consultation', 1500, true],
      ['SVC0004', 'Home Visit', 5000, true],
      ['SVC0005', 'Per-item Service', 500, true]
    ];
    svcSheet.getRange(2, 1, defaults.length, 4).setValues(defaults);
  }

  const setSheet = ss.getSheetByName(SHEET_NAMES.SETTINGS);
  if (setSheet.getLastRow() < 2) {
    const defaults = [
      ['BusinessName', 'Your Business'],
      ['Address', '123 Main Street, Lagos'],
      ['Phone', '0800-000-0000'],
      ['ReceiptFooter', 'Thank you for your patronage!'],
      ['Currency', '\u20A6'],
      ['NextCustomerNo', '1'],
      ['NextSaleNo', '1'],
      ['NextReceiptNo', '1'],
      ['NextExpenseNo', '1'],
      ['NextServiceNo', '7'],
      ['NextItemNo', '1']
    ];
    setSheet.getRange(2, 1, defaults.length, 2).setValues(defaults);
  }

  ensureCategoriesSheet_();
  formatPhoneColumns_();
  SpreadsheetApp.flush();
  return 'Setup complete.';
}

/** Run this once if you set up the sheet before the ID-counter update. */
function upgradeSettings() {
  const settings = getSettingsMap();
  const defaults = {
    NextCustomerNo: '1',
    NextSaleNo: '1',
    NextReceiptNo: '1',
    NextExpenseNo: '1',
    NextServiceNo: '1',
    NextItemNo: '1'
  };
  Object.keys(defaults).forEach(k => {
    if (!(k in settings)) setSetting(k, defaults[k]);
  });
  ensureCategoriesSheet_();
  formatPhoneColumns_();
  // New column for percentage discounts (column M on the Sales sheet).
  const salesSheet = getSS().getSheetByName(SHEET_NAMES.SALES);
  if (salesSheet && !salesSheet.getRange(1, 13).getValue()) {
    salesSheet.getRange(1, 13).setValue('DiscountPercent').setFontWeight('bold');
  }
  return 'Settings upgraded.';
}

/** Plain-text format on phone columns so numbers like 0801... keep their leading zero. */
function formatPhoneColumns_() {
  const ss = getSS();
  const cust = ss.getSheetByName(SHEET_NAMES.CUSTOMERS);
  const sales = ss.getSheetByName(SHEET_NAMES.SALES);
  if (cust) cust.getRange('C2:C').setNumberFormat('@');
  if (sales) sales.getRange('F2:F').setNumberFormat('@');
}

// ---------- Generic sheet helpers ----------

function sheetToObjects(sheetName) {
  const sheet = getSS().getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const values = sheet.getDataRange().getValues();
  const headers = values.shift();
  return values
    .filter(row => row[0] !== '' && row[0] !== null)
    .map(row => {
      const obj = {};
      headers.forEach((h, i) => {
        let v = row[i];
        // google.script.run cannot return Date objects (the client receives
        // null), so every date leaves the server as an ISO string.
        if (v instanceof Date) v = v.toISOString();
        obj[h] = v;
      });
      return obj;
    });
}

/**
 * Sequential, zero-padded IDs, e.g. getNextId('NextCustomerNo','CUS') -> 'CUS0001'.
 * Does NOT take its own lock — every caller must already hold a script lock,
 * so a counter is never handed out twice.
 */
function getNextId(counterKey, prefix) {
  const settings = getSettingsMap();
  const n = parseInt(settings[counterKey] || '1', 10);
  setSetting(counterKey, String(n + 1));
  return prefix + String(n).padStart(4, '0');
}

function normalizePhone(phone) {
  return (phone || '').toString().replace(/[^0-9]/g, '');
}

// Matching key for the unique-phone rule: the last 10 digits, so
// 08012345678, 8012345678 and +234 801 234 5678 are all the same customer.
function phoneKey(phone) {
  const d = normalizePhone(phone);
  return d.length > 10 ? d.slice(-10) : d;
}

// ---------- Settings ----------

function getSettingsMap() {
  const rows = sheetToObjects(SHEET_NAMES.SETTINGS);
  const map = {};
  rows.forEach(r => (map[r.Key] = r.Value));
  return map;
}

function setSetting(key, value) {
  const sheet = getSS().getSheetByName(SHEET_NAMES.SETTINGS);
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === key) {
      sheet.getRange(i + 1, 2).setValue(value);
      return;
    }
  }
  sheet.appendRow([key, value]);
}

// Only the business-info keys can be changed from the page (never the ID counters).
function updateBusinessSettings(data) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    ['BusinessName', 'Address', 'Phone', 'Currency', 'ReceiptFooter'].forEach(k => {
      if (data && k in data) setSetting(k, data[k]);
    });
    return getSettingsMap();
  } finally {
    lock.releaseLock();
  }
}

// ---------- Init data for the app shell ----------

function svc_getInitData() {
  const services = sheetToObjects(SHEET_NAMES.SERVICES).filter(
    s => s.Active === true || s.Active === 'TRUE' || s.Active === 'true'
  );
  const settings = getSettingsMap();
  const customers = sheetToObjects(SHEET_NAMES.CUSTOMERS)
    .sort((a, b) => new Date(b.CreatedAt) - new Date(a.CreatedAt))
    .slice(0, 50);
  return { services, settings, customers, categories: getCategories('Expense') };
}

// ---------- Categories (manageable from the web app) ----------
// Expense categories shown in the Expenses form. The Type column leaves room
// for other kinds of category later. Categories are switched off (Active =
// FALSE) rather than deleted, so old expenses keep their category name.

function isActive_(v) {
  return v === true || v === 'TRUE' || v === 'true';
}

function ensureCategoriesSheet_() {
  const ss = getSS();
  let sheet = ss.getSheetByName(SHEET_NAMES.CATEGORIES);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAMES.CATEGORIES);
    sheet.getRange(1, 1, 1, 4).setValues([['CategoryID', 'Name', 'Type', 'Active']]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  if (sheet.getLastRow() < 2) {
    const names = ['Detergent & Supplies', 'Electricity / Utilities', 'Rent', 'Staff Wages',
                   'Equipment / Maintenance', 'Transport', 'Other'];
    const rows = names.map((n, i) => ['CAT' + String(i + 1).padStart(4, '0'), n, 'Expense', true]);
    sheet.getRange(2, 1, rows.length, 4).setValues(rows);
    setSetting('NextCategoryNo', String(rows.length + 1));
  }
  return sheet;
}

function getCategories(type) {
  ensureCategoriesSheet_();
  type = type || 'Expense';
  return sheetToObjects(SHEET_NAMES.CATEGORIES).filter(c => c.Type === type && isActive_(c.Active));
}

function getAllCategories(type) {
  ensureCategoriesSheet_();
  type = type || 'Expense';
  return sheetToObjects(SHEET_NAMES.CATEGORIES).filter(c => c.Type === type);
}

function addCategory(data) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const name = (data.name || '').toString().trim();
    const type = data.type || 'Expense';
    if (!name) throw new Error('Category name is required.');
    const sheet = ensureCategoriesSheet_();
    const clash = sheetToObjects(SHEET_NAMES.CATEGORIES).find(
      c => c.Type === type && c.Name.toString().toLowerCase() === name.toLowerCase()
    );
    if (clash) throw new Error('That category already exists.');
    const id = getNextId('NextCategoryNo', 'CAT');
    sheet.appendRow([id, name, type, true]);
    return { CategoryID: id, Name: name, Type: type, Active: true };
  } finally {
    lock.releaseLock();
  }
}

function updateCategory(categoryId, data) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = ensureCategoriesSheet_();
    const values = sheet.getDataRange().getValues();
    for (let i = 1; i < values.length; i++) {
      if (values[i][0] === categoryId) {
        if (data.name !== undefined && data.name !== null) {
          const name = data.name.toString().trim();
          if (!name) throw new Error('Category name is required.');
          const clash = values.find((r, j) => j > 0 && j !== i && r[2] === values[i][2] &&
            r[1].toString().toLowerCase() === name.toLowerCase());
          if (clash) throw new Error('That category already exists.');
          sheet.getRange(i + 1, 2).setValue(name);
        }
        if (data.active !== undefined && data.active !== null) sheet.getRange(i + 1, 4).setValue(!!data.active);
        return true;
      }
    }
    throw new Error('Category not found.');
  } finally {
    lock.releaseLock();
  }
}

// ---------- Services (manageable from the web app) ----------

function getAllServices() {
  return sheetToObjects(SHEET_NAMES.SERVICES);
}

function addService(data) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (!data.name || !data.name.toString().trim()) throw new Error('Service name is required.');
    const sheet = getSS().getSheetByName(SHEET_NAMES.SERVICES);
    const id = getNextId('NextServiceNo', 'SVC');
    sheet.appendRow([id, data.name.toString().trim(), Number(data.price || 0), true]);
    return { ServiceID: id, Name: data.name, Price: Number(data.price || 0), Active: true };
  } finally {
    lock.releaseLock();
  }
}

function updateService(serviceId, data) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = getSS().getSheetByName(SHEET_NAMES.SERVICES);
    const values = sheet.getDataRange().getValues();
    for (let i = 1; i < values.length; i++) {
      if (values[i][0] === serviceId) {
        if (data.name !== undefined && data.name !== null) sheet.getRange(i + 1, 2).setValue(data.name);
        if (data.price !== undefined && data.price !== null) sheet.getRange(i + 1, 3).setValue(Number(data.price));
        if (data.active !== undefined && data.active !== null) sheet.getRange(i + 1, 4).setValue(!!data.active);
        return true;
      }
    }
    throw new Error('Service not found.');
  } finally {
    lock.releaseLock();
  }
}

// ---------- Customers ----------
// Phone number is the unique identifier: a new "customer" whose phone
// already exists returns the existing record instead of creating a
// duplicate.

function findCustomerByPhone(phone) {
  const key = phoneKey(phone);
  if (!key) return null;
  const match = sheetToObjects(SHEET_NAMES.CUSTOMERS).find(c => phoneKey(c.Phone) === key);
  return match || null;
}

function searchCustomers(query) {
  if (!query) return [];
  query = query.toString().toLowerCase().trim();
  const qDigits = normalizePhone(query);
  return sheetToObjects(SHEET_NAMES.CUSTOMERS)
    .filter(
      c =>
        (c.Name && c.Name.toString().toLowerCase().includes(query)) ||
        (qDigits.length >= 3 && normalizePhone(c.Phone).includes(qDigits))
    )
    .slice(0, 20);
}

function svc_addCustomer(data) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return addCustomerUnlocked(data);
  } finally {
    lock.releaseLock();
  }
}

// Internal version with no locking of its own — used by recordSale(),
// which already holds the lock for the whole sale transaction.
function addCustomerUnlocked(data) {
  const phone = (data.phone || '').toString().trim();
  if (!phoneKey(phone)) throw new Error('A phone number is required — it is the customer\'s unique ID.');
  const existing = findCustomerByPhone(phone);
  if (existing) return Object.assign({}, existing, { Existing: true }); // never create a duplicate

  const sheet = getSS().getSheetByName(SHEET_NAMES.CUSTOMERS);
  const id = getNextId('NextCustomerNo', 'CUS');
  const now = new Date();
  const row = sheet.getLastRow() + 1;
  sheet.getRange(row, 3).setNumberFormat('@'); // keep leading zeros in phone numbers
  sheet.getRange(row, 1, 1, 6).setValues([[id, data.name || '', phone, data.address || '', data.notes || '', now]]);
  return {
    CustomerID: id,
    Name: data.name || '',
    Phone: phone,
    Address: data.address || '',
    Notes: data.notes || '',
    CreatedAt: now.toISOString(),
    Existing: false
  };
}

/** Every customer with lifetime spend (sum of their sales) and visit count, biggest spenders first. */
function getCustomersWithSpend() {
  const totals = {};
  sheetToObjects(SHEET_NAMES.SALES).forEach(s => {
    if (!s.CustomerID) return; // walk-in sales have no customer
    const t = totals[s.CustomerID] || (totals[s.CustomerID] = { spent: 0, visits: 0 });
    t.spent += Number(s.Total) || 0;
    t.visits += 1;
  });
  return sheetToObjects(SHEET_NAMES.CUSTOMERS)
    .map(c => {
      const t = totals[c.CustomerID] || { spent: 0, visits: 0 };
      return {
        CustomerID: c.CustomerID,
        Name: c.Name,
        Phone: c.Phone,
        Address: c.Address,
        TotalSpent: Math.round(t.spent * 100) / 100,
        Visits: t.visits
      };
    })
    .sort((a, b) => b.TotalSpent - a.TotalSpent || String(a.Name).localeCompare(String(b.Name)));
}

function getCustomerHistory(customerId) {
  const sales = sheetToObjects(SHEET_NAMES.SALES).filter(s => s.CustomerID === customerId);
  return sales.sort((a, b) => new Date(b.Date) - new Date(a.Date));
}

// ---------- Sales ----------

function recordSale(saleData) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const ss = getSS();
    let customerId = saleData.customerId || '';
    let customerName = saleData.customerName || '';
    let customerPhone = saleData.customerPhone || '';

    if (!customerId && saleData.newCustomer && saleData.newCustomer.name) {
      const cust = addCustomerUnlocked(saleData.newCustomer);
      customerId = cust.CustomerID;
      customerName = cust.Name;
      customerPhone = cust.Phone;
    }

    const items = saleData.items || [];
    if (items.length === 0) throw new Error('No services added to this sale.');

    let subtotal = 0;
    items.forEach(it => {
      it.lineTotal = Number(it.qty) * Number(it.unitPrice);
      subtotal += it.lineTotal;
    });
    // Discount is a percentage of the subtotal (0-100), rounded to 2 decimals.
    let discountPercent = Number(saleData.discountPercent || 0);
    if (isNaN(discountPercent) || discountPercent < 0) discountPercent = 0;
    if (discountPercent > 100) discountPercent = 100;
    const discount = Math.round(subtotal * discountPercent) / 100;
    const total = Math.max(subtotal - discount, 0);

    const saleId = getNextId('NextSaleNo', 'SLS');
    const receiptNo = getNextId('NextReceiptNo', 'REC');
    const now = new Date();

    ss.getSheetByName(SHEET_NAMES.SALES).appendRow([
      saleId,
      receiptNo,
      now,
      customerId,
      customerName,
      customerPhone,
      subtotal,
      discountPercent,          // Discount column = percentage given (e.g. 10), not the amount
      total,
      saleData.paymentMethod || 'Cash',
      'Completed',
      now,
      discountPercent
    ]);

    const itemsSheet = ss.getSheetByName(SHEET_NAMES.SALE_ITEMS);
    items.forEach(it => {
      const itemId = getNextId('NextItemNo', 'ITM');
      itemsSheet.appendRow([itemId, saleId, it.serviceName, it.qty, it.unitPrice, it.lineTotal]);
    });

    const result = {
      saleId,
      receiptNo,
      date: now.toISOString(),
      customerName,
      customerPhone,
      items,
      subtotal,
      discount,
      discountPercent,
      total,
      paymentMethod: saleData.paymentMethod || 'Cash'
    };
    result.receiptHtml = svc_buildReceiptHtml_(toReceiptSale_(result));
    return result;
  } finally {
    lock.releaseLock();
  }
}

function getReceipt(saleId) {
  const sale = sheetToObjects(SHEET_NAMES.SALES).find(s => s.SaleID === saleId);
  if (!sale) throw new Error('Receipt not found.');
  const items = sheetToObjects(SHEET_NAMES.SALE_ITEMS).filter(it => it.SaleID === saleId);
  const settings = getSettingsMap();
  const subtotal = Number(sale.Subtotal) || 0;
  const total = Number(sale.Total) || 0;
  const discountAmt = Math.max(Math.round((subtotal - total) * 100) / 100, 0);
  const discountPct = Number(sale.DiscountPercent) || (subtotal > 0 ? Math.round(discountAmt / subtotal * 10000) / 100 : 0);
  return {
    saleId: sale.SaleID,
    receiptNo: sale.ReceiptNo,
    date: sale.Date,
    customerName: sale.CustomerName,
    customerPhone: sale.CustomerPhone,
    items: items.map(it => ({
      serviceName: it.ServiceName,
      qty: it.Qty,
      unitPrice: it.UnitPrice,
      lineTotal: it.LineTotal
    })),
    subtotal: subtotal,
    discount: discountAmt,                       // amount, worked out from Subtotal - Total
    discountPercent: discountPct,
    total: total,
    paymentMethod: sale.PaymentMethod,
    business: settings
  };
}

function getRecentSales(limit) {
  limit = limit || 20;
  const sales = sheetToObjects(SHEET_NAMES.SALES);
  return sales.sort((a, b) => new Date(b.Date) - new Date(a.Date)).slice(0, limit);
}

// ---------- Receipt (your format) ----------

// Change this one line to change the receipt font. Use fonts the printer/PDF
// can find without internet (Arial, Helvetica, Georgia, 'Courier New', Verdana).
const SVC_RECEIPT_FONT = "Arial, Helvetica, sans-serif";

// The receipt template reads the settings under these names.
function svc_getConfig() {
  const s = getSettingsMap();
  s.Footer = s.ReceiptFooter;
  return s;
}

// Maps the app's receipt data onto the shape the template expects.
function toReceiptSale_(r) {
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

function svc_getReceiptHtml(saleId) {
  return svc_buildReceiptHtml_(toReceiptSale_(getReceipt(saleId)));
}

/** Server-side PDF of a stored receipt, returned base64-encoded for download. */
function getReceiptPdf(saleId) {
  const r = getReceipt(saleId);
  const html = svc_buildReceiptHtml_(toReceiptSale_(r));
  const pdf = Utilities.newBlob(html, 'text/html', r.receiptNo + '.html').getAs('application/pdf');
  return { name: r.receiptNo + '.pdf', base64: Utilities.base64Encode(pdf.getBytes()) };
}

function svc_buildReceiptHtml_(sale) {
  const config = svc_getConfig();
  const currency = config.Currency || '';
  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const money = n => currency + Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2
  });
  const when = Utilities.formatDate(new Date(sale.date), Session.getScriptTimeZone(), 'dd MMM yyyy, h:mm a');

  const itemsHtml = sale.items.map(it => {
    const line = Number(it.qty) * Number(it.price);
    return '<table class="item">' +
      '<tr><td colspan="2" class="item-name">' + esc(it.name) + '</td></tr>' +
      '<tr><td class="item-calc">' + esc(it.qty) + ' &times; ' + money(it.price) + '</td>' +
      '<td class="amt">' + money(line) + '</td></tr>' +
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
      '<tr><td>Subtotal</td><td class="amt">' + money(sale.subtotal) + '</td></tr>' +
      (Number(sale.discount) ? '<tr><td>Discount' + (Number(sale.discountPercent) ? ' (' + Number(sale.discountPercent) + '%)' : '') + '</td><td class="amt">-' + money(sale.discount) + '</td></tr>' : '') +
      '<tr class="grand"><td>TOTAL</td><td class="amt">' + money(sale.total) + '</td></tr>' +
    '</table>' +
    '<div class="footer">' + esc(config.Footer || 'Thank you!') + '</div>' +
    '</body></html>'
  );
}

// ---------- Expenses ----------

function addExpense(data) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = getSS().getSheetByName(SHEET_NAMES.EXPENSES);
    const id = getNextId('NextExpenseNo', 'EXP');
    const now = new Date();
    const date = data.date ? new Date(data.date) : now;
    sheet.appendRow([id, date, data.category || 'General', data.description || '', Number(data.amount || 0), now]);
    return { ExpenseID: id, Date: date.toISOString(), Category: data.category, Description: data.description, Amount: data.amount };
  } finally {
    lock.releaseLock();
  }
}

function getExpenses(startDate, endDate) {
  let expenses = sheetToObjects(SHEET_NAMES.EXPENSES);
  if (startDate) {
    const start = new Date(startDate);
    expenses = expenses.filter(e => new Date(e.Date) >= start);
  }
  if (endDate) {
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    expenses = expenses.filter(e => new Date(e.Date) <= end);
  }
  return expenses.sort((a, b) => new Date(b.Date) - new Date(a.Date));
}

// ---------- Reports ----------

/**
 * Sales + expenses summary for a date range. from / to are 'yyyy-MM-dd' (either can be
 * blank = no limit). Returns the totals and the newest 200 sales in the range.
 */
function getReportSummary(from, to) {
  const parse = (str, addDays) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || ''));
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + addDays) : null;
  };
  const start = parse(from, 0);
  const end = parse(to, 1);                       // start of the day AFTER "to"
  if (start && end && start >= end) throw new Error('"From" date is after "To" date.');
  const inRange = v => {
    const d = new Date(v);
    return !isNaN(d.getTime()) && (!start || d >= start) && (!end || d < end);
  };

  const sales = sheetToObjects(SHEET_NAMES.SALES).filter(s => inRange(s.Date))
    .sort((a, b) => new Date(b.Date) - new Date(a.Date));
  const expenses = sheetToObjects(SHEET_NAMES.EXPENSES).filter(e => inRange(e.Date));

  const round2 = n => Math.round(n * 100) / 100;
  const totalSales = round2(sales.reduce((sum, s) => sum + Number(s.Total || 0), 0));
  const totalExpenses = round2(expenses.reduce((sum, e) => sum + Number(e.Amount || 0), 0));

  return {
    from: from || '',
    to: to || '',
    salesCount: sales.length,
    totalSales,
    totalExpenses,
    net: round2(totalSales - totalExpenses),
    sales: sales.slice(0, 200),
    truncated: sales.length > 200
  };
}
