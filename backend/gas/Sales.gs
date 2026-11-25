/**
 * SALES TRACKER — backend (called through api() in Router.gs)
 * ------------------------------------------------------------
 * Each business spreadsheet needs:
 *   Products   | ProductID | Name | Category | CostPrice | SellingPrice | Stock | Unit
 *   Customers  | CustomerID | Name | Phone | Email | Address | TotalPurchases | DateAdded
 *   Sales      | SaleID | Date | CustomerID | CustomerName | Subtotal | Discount | Total | PaymentMethod | ItemsJSON | ReceiptID | ReceiptUrl
 *              (Discount = the discount GIVEN, as a percentage number, e.g. 10 for 10%. Older rows may still hold an amount.)
 *   SaleItems  | SaleID | ProductID | ProductName | Qty | Price | LineTotal | CostPrice | Profit
 *   Config     | Key | Value   (BusinessName, Address, Phone, Footer, Currency, *Counter rows)
 *   Expenses   | ExpenseID | Date | ProductID | ProductName | Type | Qty | UnitCost | TotalCost | SellingPrice | QtyRemaining
 *              (created automatically; one row per purchase batch. Type = New / Restock / Opening)
 *   Categories | CategoryID | Name | Type | Active      (created automatically; Type = Product or Expense)
 *   RunningExpenses | ExpenseID | Date | Category | Description | Amount | CreatedAt   (created automatically)
 */

const SHEETS = {
  PRODUCTS: 'Products',
  CUSTOMERS: 'Customers',
  SALES: 'Sales',
  SALE_ITEMS: 'SaleItems',
  CONFIG: 'Config',
  EXPENSES: 'Expenses',
  CATEGORIES: 'Categories',
  RUNNING: 'RunningExpenses'
};
const RECEIPT_FOLDER_NAME = 'Sales Tracker Receipts';

// ---------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------
function getSheet_(name) {
  if (!SS) throw new Error('No business selected');
  const sheet = SS.getSheetByName(name);
  if (!sheet) throw new Error('Missing sheet: ' + name);
  return sheet;
}

function sheetToObjects_(sheetName) {
  const sheet = getSheet_(sheetName);
  const range = sheet.getDataRange().getValues();
  if (range.length < 2) return [];
  const headers = range[0];
  const rows = range.slice(1);
  return rows
    .filter(r => r.join('') !== '')
    .map(r => {
      const obj = {};
      headers.forEach((h, i) => {
        const v = r[i];
        obj[h] = v instanceof Date ? v.toISOString() : v;
      });
      return obj;
    });
}

/**
 * Generates clean sequential IDs like cus0001, prd0001, sal0001, rec0001.
 * The running count for each id type is stored as a row on the business's
 * Config sheet (key = counterKey).
 *
 * IMPORTANT: this function does NOT take its own lock. Every caller must
 * already hold the script lock (saveSale, addProduct, sales_addCustomer and
 * ensureReceiptId_ all do). An inner lock here would release the caller's
 * lock early.
 */
function nextSequentialId_(prefix, counterKey) {
  const sheet = getSheet_(SHEETS.CONFIG);
  const data = sheet.getDataRange().getValues();
  let rowIndex = -1;
  let current = 0;
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === counterKey) {
      rowIndex = i + 1; // 1-indexed sheet row
      current = Number(data[i][1]) || 0;
      break;
    }
  }
  const next = current + 1;
  if (rowIndex > 0) {
    sheet.getRange(rowIndex, 2).setValue(next);
  } else {
    sheet.appendRow([counterKey, next]);
  }
  return prefix + String(next).padStart(4, '0');
}

// Each business gets its own receipts folder in the owner's Drive
function getReceiptFolder_() {
  const name = RECEIPT_FOLDER_NAME + ' - ' + BIZ_NAME;
  const folders = DriveApp.getFoldersByName(name);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(name);
}

// ---------------------------------------------------------------
// LISTS + CONFIG
// ---------------------------------------------------------------
// ---------------------------------------------------------------
// EXPENSES (goods bought) + STOCK LAYERS
// ---------------------------------------------------------------
// Every purchase (new product or restock) is one row in the Expenses sheet and
// keeps its own cost and selling price until that batch is sold out.
// Stock is sold oldest batch first (FIFO).
//
// Selling-price rule on a restock:
//   - new price HIGHER than a batch still in stock -> that stock goes up to the new price
//   - new price LOWER  -> the stock already on the shelf keeps its old price until it is
//     sold out; only then does the lower price start
// Products.SellingPrice / CostPrice always show the price of the OLDEST stock still on hand.
const EXP_HEADERS = ['ExpenseID', 'Date', 'ProductID', 'ProductName', 'Type', 'Qty',
                     'UnitCost', 'TotalCost', 'SellingPrice', 'QtyRemaining'];
const EXP_COL_SELL = 9, EXP_COL_REMAINING = 10;

function getExpensesSheet_() {
  if (!SS) throw new Error('No business selected');
  let sh = SS.getSheetByName(SHEETS.EXPENSES);
  if (!sh) {
    sh = SS.insertSheet(SHEETS.EXPENSES);
    sh.getRange(1, 1, 1, EXP_HEADERS.length).setValues([EXP_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

// Batches of one product that still have stock, oldest first ("Opening" stock goes first)
function batchesFor_(expData, productId) {
  const out = [];
  for (let i = 1; i < expData.length; i++) {
    const r = expData[i];
    if (r[2] === productId && Number(r[9]) > 0) {
      out.push({ sheetRow: i + 1, type: r[4], qty: Number(r[9]), price: Number(r[8]) || 0,
                 cost: Number(r[6]) || 0, order: i });
    }
  }
  out.sort((a, b) => (a.type === 'Opening' ? 0 : 1) - (b.type === 'Opening' ? 0 : 1) || a.order - b.order);
  return out;
}

// FIFO layers for a product row [id, name, category, cost, sell, stock]. The Stock column
// is the truth: stock not covered by a batch is shown as an opening layer at the product's
// own price, and any excess in the batches is trimmed from the oldest.
function layersFor_(prodRow, expData) {
  const stock = Math.max(Number(prodRow[5]) || 0, 0);
  let layers = batchesFor_(expData, prodRow[0]);
  const sum = layers.reduce((s, l) => s + l.qty, 0);
  if (sum < stock) {
    layers.unshift({ sheetRow: 0, type: 'Opening', qty: stock - sum,
                     price: Number(prodRow[4]) || 0, cost: Number(prodRow[3]) || 0 });
  } else if (sum > stock) {
    let excess = sum - stock;
    layers = layers.map(l => {
      const cut = Math.min(excess, l.qty);
      excess -= cut;
      return Object.assign({}, l, { qty: l.qty - cut });
    }).filter(l => l.qty > 0);
  }
  return layers;
}

// Turns stock that has no batch yet (e.g. products added before this feature) into an
// "Opening" batch, so every unit on the shelf belongs to a batch. Caller holds the lock.
function ensureOpening_() {
  const pData = getSheet_(SHEETS.PRODUCTS).getDataRange().getValues();
  const eSheet = getExpensesSheet_();
  const eData = eSheet.getDataRange().getValues();
  const rows = [];
  for (let i = 1; i < pData.length; i++) {
    const p = pData[i];
    if (!p[0]) continue;
    const stock = Number(p[5]) || 0;
    if (stock <= 0) continue;
    const covered = batchesFor_(eData, p[0]).reduce((s, l) => s + l.qty, 0);
    if (covered < stock) {
      const q = stock - covered;
      rows.push([nextSequentialId_('exp', 'ExpenseCounter'), new Date(), p[0], p[1], 'Opening',
                 q, Number(p[3]) || 0, 0, Number(p[4]) || 0, q]);
    }
  }
  if (rows.length) {
    eSheet.getRange(eSheet.getLastRow() + 1, 1, rows.length, EXP_HEADERS.length).setValues(rows);
  }
}

function getProductsList() {
  const products = sheetToObjects_(SHEETS.PRODUCTS);
  const eData = getExpensesSheet_().getDataRange().getValues();
  products.forEach(p => {
    const layers = layersFor_([p.ProductID, p.Name, p.Category, p.CostPrice, p.SellingPrice, p.Stock], eData);
    const tiers = [];
    layers.forEach(l => {
      const last = tiers[tiers.length - 1];
      if (last && last.price === l.price) last.qty += l.qty;
      else tiers.push({ qty: l.qty, price: l.price });
    });
    p.Tiers = tiers;                              // [{qty, price}] in the order they will sell
    if (tiers.length) p.SellingPrice = tiers[0].price;
  });
  return products;
}

// Purchases list for the Expenses tab (newest first)
function getExpensesList() {
  const data = getExpensesSheet_().getDataRange().getValues();
  const out = [];
  for (let i = data.length - 1; i >= 1; i--) {
    const r = data[i];
    if (!r[0]) continue;
    out.push({
      id: r[0], date: r[1] instanceof Date ? r[1].toISOString() : r[1],
      productId: r[2], name: r[3], type: r[4],
      qty: Number(r[5]) || 0, unitCost: Number(r[6]) || 0, total: Number(r[7]) || 0,
      sellingPrice: Number(r[8]) || 0, remaining: Number(r[9]) || 0
    });
  }
  return out;
}

// ---------------------------------------------------------------
// CATEGORIES (editable dropdown lists) + RUNNING EXPENSES
// ---------------------------------------------------------------
// Categories sheet: Type = 'Product' (shown when buying stock) or 'Expense' (running costs).
// Categories are switched off (Active = FALSE) rather than deleted. Renaming one also
// renames it on the products / expenses that already use it.
const CAT_HEADERS = ['CategoryID', 'Name', 'Type', 'Active'];
const RUN_HEADERS = ['ExpenseID', 'Date', 'Category', 'Description', 'Amount', 'CreatedAt'];
const DEFAULT_EXPENSE_CATEGORIES = ['Fuel', 'Transport', 'Rent', 'Electricity / Utilities', 'Staff Wages',
                                    'Domestic / Household', 'Equipment / Maintenance', 'Other'];

function catOn_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }

function getCategoriesSheet_() {
  if (!SS) throw new Error('No business selected');
  let sh = SS.getSheetByName(SHEETS.CATEGORIES);
  if (sh) return sh;
  sh = SS.insertSheet(SHEETS.CATEGORIES);
  sh.getRange(1, 1, 1, CAT_HEADERS.length).setValues([CAT_HEADERS]).setFontWeight('bold');
  sh.setFrozenRows(1);
  // Starter lists: categories already typed on existing products + common running costs
  const rows = [];
  const seen = {};
  const pSheet = SS.getSheetByName(SHEETS.PRODUCTS);
  if (pSheet) {
    pSheet.getDataRange().getValues().slice(1).forEach(r => {
      const c = String(r[2] || '').trim().replace(/\s+/g, ' ');
      if (c && !seen[c.toLowerCase()]) { seen[c.toLowerCase()] = true; rows.push(['Product', c]); }
    });
  }
  DEFAULT_EXPENSE_CATEGORIES.forEach(n => rows.push(['Expense', n]));
  const out = rows.map(r => [nextSequentialId_('cat', 'CategoryCounter'), r[1], r[0], true]);
  sh.getRange(2, 1, out.length, CAT_HEADERS.length).setValues(out);
  return sh;
}

function getCategoriesList() {
  const data = getCategoriesSheet_().getDataRange().getValues();
  const out = [];
  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    if (!r[0]) continue;
    out.push({ CategoryID: r[0], Name: String(r[1]), Type: r[2], Active: catOn_(r[3]) });
  }
  return out;
}

// Adds a category, or returns / re-activates the one that already has that name. Caller holds the lock.
function sales_addCategoryUnlocked_(name, type) {
  name = String(name || '').trim().replace(/\s+/g, ' ');
  if (!name) throw new Error('Category name is required.');
  if (type !== 'Product' && type !== 'Expense') throw new Error('Unknown category type.');
  const sh = getCategoriesSheet_();
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][2] === type && String(data[i][1]).trim().toLowerCase() === name.toLowerCase()) {
      if (!catOn_(data[i][3])) sh.getRange(i + 1, 4).setValue(true);
      return { CategoryID: data[i][0], Name: String(data[i][1]), Type: type, Active: true, existing: true };
    }
  }
  const id = nextSequentialId_('cat', 'CategoryCounter');
  sh.appendRow([id, name, type, true]);
  return { CategoryID: id, Name: name, Type: type, Active: true, existing: false };
}

function sales_addCategory(data) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return sales_addCategoryUnlocked_(data && data.name, data && data.type);
  } finally {
    lock.releaseLock();
  }
}

// data = { name?, active? }
function sales_updateCategory(categoryId, data) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sh = getCategoriesSheet_();
    const values = sh.getDataRange().getValues();
    for (let i = 1; i < values.length; i++) {
      if (values[i][0] !== categoryId) continue;
      const type = values[i][2];
      const oldName = String(values[i][1]);
      if (data && data.name !== undefined && data.name !== null) {
        const name = String(data.name).trim().replace(/\s+/g, ' ');
        if (!name) throw new Error('Category name is required.');
        const clash = values.some((r, j) => j > 0 && j !== i && r[2] === type &&
          String(r[1]).trim().toLowerCase() === name.toLowerCase());
        if (clash) throw new Error('That category already exists.');
        if (name !== oldName) {
          sh.getRange(i + 1, 2).setValue(name);
          renameCategoryUses_(type, oldName, name);
        }
      }
      if (data && data.active !== undefined && data.active !== null) {
        sh.getRange(i + 1, 4).setValue(!!data.active);
      }
      return true;
    }
    throw new Error('Category not found.');
  } finally {
    lock.releaseLock();
  }
}

// Category is column 3 on both the Products and the RunningExpenses sheet
function renameCategoryUses_(type, oldName, newName) {
  const sheet = type === 'Product' ? getSheet_(SHEETS.PRODUCTS) : getRunningSheet_();
  const n = sheet.getLastRow() - 1;
  if (n < 1) return;
  const range = sheet.getRange(2, 3, n, 1);
  const vals = range.getValues();
  let changed = false;
  vals.forEach(r => { if (String(r[0]).trim() === oldName) { r[0] = newName; changed = true; } });
  if (changed) range.setValues(vals);
}

function getRunningSheet_() {
  if (!SS) throw new Error('No business selected');
  let sh = SS.getSheetByName(SHEETS.RUNNING);
  if (!sh) {
    sh = SS.insertSheet(SHEETS.RUNNING);
    sh.getRange(1, 1, 1, RUN_HEADERS.length).setValues([RUN_HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function parseDay_(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0) : null;   // noon: no timezone drift
}

/** Records a running cost of the business (fuel, transport, rent, domestic, ...). */
function addRunningExpense(data) {
  const amount = Number(data && data.amount);
  if (!(amount > 0)) throw new Error('Enter an amount.');
  const category = String((data && data.category) || '').trim().replace(/\s+/g, ' ') || 'Other';
  const description = String((data && data.description) || '').trim();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    sales_addCategoryUnlocked_(category, 'Expense');           // keeps the dropdown list in step
    const id = nextSequentialId_('rex', 'RunExpCounter');
    const date = parseDay_(data.date) || new Date();
    getRunningSheet_().appendRow([id, date, category, description, amount, new Date()]);
    return { id: id, date: date.toISOString(), category: category, description: description, amount: amount };
  } finally {
    lock.releaseLock();
  }
}

// Running expenses, newest first
function getRunningExpenses() {
  const data = getRunningSheet_().getDataRange().getValues();
  const out = [];
  for (let i = data.length - 1; i >= 1; i--) {
    const r = data[i];
    if (!r[0]) continue;
    out.push({ id: r[0], date: r[1] instanceof Date ? r[1].toISOString() : r[1],
               category: String(r[2] || ''), description: String(r[3] || ''), amount: Number(r[4]) || 0 });
  }
  return out.sort((a, b) => new Date(b.date) - new Date(a.date));
}

function getCustomersList() {
  return sheetToObjects_(SHEETS.CUSTOMERS);
}

function sales_getConfig() {
  const rows = sheetToObjects_(SHEETS.CONFIG);
  const config = {};
  rows.forEach(r => (config[r.Key] = r.Value));
  return config;
}

// ---------------------------------------------------------------
// PRODUCTS
// ---------------------------------------------------------------
/**
 * BUY / RESTOCK a product. A new name creates the product with an automatic ID; an
 * existing name (case-insensitive) is a restock. Either way the purchase is recorded
 * in the Expenses sheet as its own batch with its own cost and selling price.
 * product = { name, category, unit, costPrice, sellingPrice, stock }  (stock = quantity bought)
 */
function addProduct(product) {
  const name = String((product && product.name) || '').trim().replace(/\s+/g, ' ');
  if (!name) throw new Error('Product name is required.');
  const qty = Number(product.stock);
  if (!(qty > 0)) throw new Error('Enter the quantity bought.');
  const has = v => v !== undefined && v !== null && v !== '';

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    ensureOpening_();
    const pSheet = getSheet_(SHEETS.PRODUCTS);
    const eSheet = getExpensesSheet_();
    const pData = pSheet.getDataRange().getValues();
    const eData = eSheet.getDataRange().getValues();

    let idx = -1;
    const nameLower = name.toLowerCase();
    for (let i = 1; i < pData.length; i++) {
      if (String(pData[i][1] || '').trim().replace(/\s+/g, ' ').toLowerCase() === nameLower) { idx = i; break; }
    }

    if (idx === -1) {
      // ---- brand-new product ----
      const sell = Number(product.sellingPrice) || 0;
      if (!(sell > 0)) throw new Error('Enter a selling price for a new product.');
      const cost = Number(product.costPrice) || 0;
      // never reuse an ID that already exists (in case the counter is behind)
      let id;
      do { id = nextSequentialId_('prd', 'ProductCounter'); }
      while (pData.some((r, i) => i > 0 && r[0] === id));
      const category = String(product.category || '').trim().replace(/\s+/g, ' ');
      if (category) sales_addCategoryUnlocked_(category, 'Product');
      const unit = product.unit || 'pcs';
      pSheet.appendRow([id, name, category, cost, sell, qty, unit]);
      eSheet.appendRow([nextSequentialId_('exp', 'ExpenseCounter'), new Date(), id, name, 'New',
                        qty, cost, qty * cost, sell, qty]);
      return { id: id, existing: false, name: name, category: category, costPrice: cost,
               sellingPrice: sell, stock: qty, unit: unit };
    }

    // ---- restock ----
    const row = pData[idx];
    const layers = layersFor_(row, eData);
    const newest = layers.length ? layers[layers.length - 1] : null;
    const cost = has(product.costPrice) ? Number(product.costPrice) : (newest ? newest.cost : Number(row[3]) || 0);
    const sell = has(product.sellingPrice) ? Number(product.sellingPrice) : (newest ? newest.price : Number(row[4]) || 0);
    if (!(sell > 0)) throw new Error('Enter a selling price.');

    // Higher new price lifts the stock still on hand; a lower price leaves it alone
    layers.forEach(l => {
      if (sell > l.price) {
        if (l.sheetRow) eSheet.getRange(l.sheetRow, EXP_COL_SELL).setValue(sell);
        l.price = sell;
      }
    });
    eSheet.appendRow([nextSequentialId_('exp', 'ExpenseCounter'), new Date(), row[0], row[1], 'Restock',
                      qty, cost, qty * cost, sell, qty]);

    layers.push({ qty: qty, price: sell, cost: cost });
    const front = layers[0];                       // oldest stock sets the displayed price
    const newStock = (Number(row[5]) || 0) + qty;
    pSheet.getRange(idx + 1, 4, 1, 3).setValues([[front.cost, front.price, newStock]]);
    return { id: row[0], existing: true, name: row[1], category: row[2], costPrice: front.cost,
             sellingPrice: front.price, stock: newStock, unit: row[6] };
  } finally {
    lock.releaseLock();
  }
}

function updateProduct(product) {
  const sheet = getSheet_(SHEETS.PRODUCTS);
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === product.id) {
      sheet.getRange(i + 1, 2, 1, 6).setValues([[
        product.name,
        product.category || '',
        Number(product.costPrice) || 0,
        Number(product.sellingPrice) || 0,
        Number(product.stock) || 0,
        product.unit || 'pcs'
      ]]);
      return { success: true };
    }
  }
  throw new Error('Product not found: ' + product.id);
}

// ---------------------------------------------------------------
// CUSTOMERS
// ---------------------------------------------------------------
/**
 * Adds a customer. The PHONE NUMBER is the unique identifier:
 *  - Same phone number  -> same customer (reused, details updated)
 *  - Same name, different phone -> a separate customer with its own ID
 *  - No phone given -> only matches an existing customer who also has no
 *    phone and the same name; otherwise a new customer is created.
 * Phones are compared by their last 10 digits, so 0803 123 4567,
 * +234 803 123 4567 and 803-123-4567 all count as the same number.
 */
function sales_addCustomer(customer) {
  if (!customer || typeof customer.name !== 'string' || !customer.name.trim()) {
    throw new Error('Customer name is required.');
  }

  const normalize = s => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const phoneKey = p => String(p || '').replace(/\D/g, '').slice(-10);
  const str = v => (v == null ? '' : String(v).trim());

  const nameKey = normalize(customer.name);
  const newPhoneKey = phoneKey(customer.phone);

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getSheet_(SHEETS.CUSTOMERS);
    const data = sheet.getDataRange().getValues();

    for (let i = 1; i < data.length; i++) {
      const rowPhoneKey = phoneKey(data[i][2]);
      const isMatch = newPhoneKey
        ? rowPhoneKey === newPhoneKey
        : (!rowPhoneKey && normalize(data[i][1]) === nameKey);

      if (isMatch) {
        const phone = str(data[i][2]) || str(customer.phone);
        const email = str(customer.email) || str(data[i][3]);
        const address = str(customer.address) || str(data[i][4]);
        const range = sheet.getRange(i + 1, 3, 1, 3);
        range.setNumberFormat('@');            // keep leading zeros
        range.setValues([[phone, email, address]]);
        return { id: data[i][0], existing: true, name: data[i][1],
                 phone, email, address, totalPurchases: Number(data[i][5]) || 0 };
      }
    }

    const id = nextSequentialId_('cus', 'CustomerCounter');
    const name = customer.name.trim().replace(/\s+/g, ' ');
    const phone = str(customer.phone), email = str(customer.email), address = str(customer.address);

    sheet.appendRow([id, name, '', email, address, 0, new Date()]);
    const row = sheet.getLastRow();
    sheet.getRange(row, 3).setNumberFormat('@').setValue(phone);  // phone as text
    SpreadsheetApp.flush();

    return { id, existing: false, name, phone, email, address, totalPurchases: 0 };
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------
// SALES
// ---------------------------------------------------------------
function saveSale(sale) {
  // sale = { customerId, customerName, items:[{productId,name,qty}], discountPercent, paymentMethod }
  // Prices and costs are looked up here from the stock batches (oldest first); whatever
  // price the browser sends is ignored. A product sold across two price batches becomes
  // two lines on the receipt.
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const reqItems = sale.items || [];
    if (!reqItems.length) throw new Error('No items in sale.');

    ensureOpening_();
    const productsSheet = getSheet_(SHEETS.PRODUCTS);
    const expSheet = getExpensesSheet_();
    const productData = productsSheet.getDataRange().getValues();
    const expData = expSheet.getDataRange().getValues();

    // 1. Total quantity wanted per product
    const wanted = {};
    reqItems.forEach(it => {
      const idx = findProductRowIndex_(productData, it.productId, it.name);
      if (idx === -1) throw new Error('Product not found: ' + (it.name || it.productId));
      const q = Number(it.qty);
      if (!(q > 0)) throw new Error('Invalid quantity for ' + (it.name || it.productId));
      wanted[idx] = (wanted[idx] || 0) + q;
    });

    // 2. Check stock and split each product across its batches. Nothing is written yet.
    const items = [];
    const batchWrites = [];     // [expenses sheet row, new QtyRemaining]
    const productWrites = [];   // [products sheet row, cost, price, stock]
    Object.keys(wanted).forEach(k => {
      const idx = Number(k), row = productData[idx], need = wanted[idx];
      const stock = Number(row[5]) || 0;
      if (need > stock) {
        throw new Error(row[1] + ': ' + (stock <= 0 ? 'out of stock' : 'only ' + stock + ' left in stock'));
      }
      const layers = layersFor_(row, expData);
      let left = need;
      layers.forEach(l => {
        if (left <= 0) return;
        const take = Math.min(left, l.qty);
        items.push({ productId: row[0], name: row[1], qty: take, price: l.price, cost: l.cost });
        if (l.sheetRow) batchWrites.push([l.sheetRow, l.qty - take]);
        l.qty -= take;
        left -= take;
      });
      if (left > 0) throw new Error(row[1] + ': not enough stock');
      const front = layers.find(l => l.qty > 0);   // next price to sell at
      productWrites.push([idx + 1, front ? front.cost : Number(row[3]) || 0,
                          front ? front.price : Number(row[4]) || 0, stock - need]);
    });

    // 3. Totals (discount is recalculated here from the percentage)
    const subtotal = items.reduce((sum, it) => sum + it.qty * it.price, 0);
    let pct = Number(sale.discountPercent);
    if (isNaN(pct)) pct = 0;
    pct = Math.min(Math.max(pct, 0), 100);
    const discount = Math.round(subtotal * pct) / 100;
    const total = Math.max(subtotal - discount, 0);
    const saleId = nextSequentialId_('sal', 'SalesCounter');
    const receiptId = nextSequentialId_('rec', 'ReceiptCounter');
    const date = new Date();
    const receiptItems = items.map(it => ({ productId: it.productId, name: it.name, qty: it.qty, price: it.price }));

    // 4. Write everything
    getSheet_(SHEETS.SALES).appendRow([
      saleId, date, sale.customerId || '', sale.customerName || 'Walk-in',
      subtotal, pct, total, sale.paymentMethod || 'Cash',      // Discount column = percentage given
      JSON.stringify(receiptItems), receiptId,
      '' // ReceiptUrl filled in when a PDF copy is archived
    ]);

    const itemsSheet = getSheet_(SHEETS.SALE_ITEMS);
    items.forEach(it => {
      const lineTotal = it.qty * it.price;
      itemsSheet.appendRow([saleId, it.productId, it.name, it.qty, it.price, lineTotal,
                            it.cost, lineTotal - it.qty * it.cost]);
    });

    batchWrites.forEach(w => expSheet.getRange(w[0], EXP_COL_REMAINING).setValue(w[1]));
    productWrites.forEach(w => productsSheet.getRange(w[0], 4, 1, 3).setValues([[w[1], w[2], w[3]]]));

    // 5. Customer's running total
    if (sale.customerId) {
      const custSheet = getSheet_(SHEETS.CUSTOMERS);
      const custData = custSheet.getDataRange().getValues();
      for (let i = 1; i < custData.length; i++) {
        if (custData[i][0] === sale.customerId) {
          const currentTotal = Number(custData[i][5]) || 0;
          custSheet.getRange(i + 1, 6).setValue(currentTotal + total);
          break;
        }
      }
    }

    return {
      saleId: saleId,
      receiptId: receiptId,
      date: date.toISOString(),
      customerName: sale.customerName || 'Walk-in',
      items: receiptItems,
      subtotal: subtotal,
      discount: discount,
      total: total,
      paymentMethod: sale.paymentMethod || 'Cash'
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Finds a product's row index by ProductID first; if no ID is given (or no
 * match is found), falls back to a case-insensitive match on product Name.
 * Returns -1 if neither matches. `productData` is a full getValues() array
 * including the header row.
 */
function findProductRowIndex_(productData, productId, name) {
  if (productId) {
    for (let i = 1; i < productData.length; i++) {
      if (productData[i][0] === productId) return i;
    }
  }
  const nameLower = (name || '').trim().toLowerCase();
  if (nameLower) {
    for (let i = 1; i < productData.length; i++) {
      if ((productData[i][1] || '').toString().trim().toLowerCase() === nameLower) return i;
    }
  }
  return -1;
}

function getSalesHistory(limitCount) {
  const rows = sheetToObjects_(SHEETS.SALES);
  const sorted = rows.sort((a, b) => new Date(b.Date) - new Date(a.Date));
  const sliced = limitCount ? sorted.slice(0, limitCount) : sorted;
  return sliced.map(r => ({
    saleId: r.SaleID,
    date: new Date(r.Date).toISOString(),
    customerName: r.CustomerName,
    total: r.Total,
    paymentMethod: r.PaymentMethod
  }));
}

function getSaleById(saleId) {
  const rows = sheetToObjects_(SHEETS.SALES);
  const row = rows.find(r => r.SaleID === saleId);
  if (!row) throw new Error('Sale not found: ' + saleId);
  const subtotal = Number(row.Subtotal) || 0;
  const total = Number(row.Total) || 0;
  const discountAmt = Math.max(Math.round((subtotal - total) * 100) / 100, 0);
  const discountPct = subtotal > 0 ? Math.round(discountAmt / subtotal * 10000) / 100 : 0;
  return {
    saleId: row.SaleID,
    receiptId: row.ReceiptID || '',
    date: new Date(row.Date).toISOString(),
    customerName: row.CustomerName,
    items: JSON.parse(row.ItemsJSON || '[]'),
    subtotal: subtotal,
    discount: discountAmt,            // amount, worked out from Subtotal - Total (works for old and new rows)
    discountPercent: discountPct,
    total: total,
    paymentMethod: row.PaymentMethod
  };
}

/**
 * Ensures a sale has a ReceiptID, generating and persisting one if it's
 * missing (covers sales created before receipt numbers existed).
 */
function ensureReceiptId_(sale) {
  if (sale.receiptId) return sale.receiptId;
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const receiptId = nextSequentialId_('rec', 'ReceiptCounter');
    const sheet = getSheet_(SHEETS.SALES);
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === sale.saleId) {
        sheet.getRange(i + 1, 10).setValue(receiptId); // ReceiptID column
        break;
      }
    }
    sale.receiptId = receiptId;
    return receiptId;
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------
// RECEIPT PDF (stores a copy in Drive for record-keeping)
// ---------------------------------------------------------------
// Change this one line to change the receipt font. Use fonts the printer/PDF
// can find without internet (Arial, Helvetica, Georgia, 'Courier New', Verdana).
const SALES_RECEIPT_FONT = "Arial, Helvetica, sans-serif";

function sales_buildReceiptHtml_(sale) {
  const config = sales_getConfig();
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
    'body{font-family:' + SALES_RECEIPT_FONT + ';font-size:13px;line-height:1.5;color:#111;max-width:300px;margin:0 auto;padding:16px 14px;}',
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

/**
 * Renders the receipt as HTML for on-screen printing. Built entirely from the
 * saved Sales row on the server — never from anything the browser page has in
 * memory — so the printed receipt always matches what was actually recorded.
 */
function sales_getReceiptHtml(saleId) {
  const sale = getSaleById(saleId);
  ensureReceiptId_(sale);
  return sales_buildReceiptHtml_(sale);
}

/** PDF of the receipt (receipt content only), returned base64-encoded so the phone can share/download it. */
function sales_getReceiptPdf(saleId) {
  const sale = getSaleById(saleId);
  ensureReceiptId_(sale);
  const html = sales_buildReceiptHtml_(sale);
  const pdf = Utilities.newBlob(html, 'text/html', sale.receiptId + '.html').getAs('application/pdf');
  return { name: sale.receiptId + '.pdf', base64: Utilities.base64Encode(pdf.getBytes()) };
}

/**
 * Generates a PDF copy of the receipt, saves it to the business's Drive
 * folder, and stores the link back on the Sales row. Reuses the sale's
 * existing ReceiptID rather than minting a new one.
 */
function generateReceiptPdf(saleId) {
  const sale = getSaleById(saleId);
  ensureReceiptId_(sale);
  const html = sales_buildReceiptHtml_(sale);
  const blob = Utilities.newBlob(html, 'text/html', sale.receiptId + '.html').getAs('application/pdf');
  blob.setName('Receipt_' + sale.receiptId + '.pdf');

  const folder = getReceiptFolder_();
  const file = folder.createFile(blob);
  const url = file.getUrl();

  // Save url back onto the Sales row
  const sheet = getSheet_(SHEETS.SALES);
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === saleId) {
      sheet.getRange(i + 1, 11).setValue(url); // ReceiptUrl column
      break;
    }
  }
  return { url: url, receiptId: sale.receiptId };
}
