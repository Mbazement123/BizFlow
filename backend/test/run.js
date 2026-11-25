'use strict';
// Runs the REAL Apps Script code (backend/gas) against a fake Google Sheets, end to end.
const assert = require('node:assert/strict');
const path = require('path');
const { FakeSheets } = require('./fake-sheets');
const { createCore } = require('../src/core');
const { serialToDate, dateToSerial } = require('../src/tz');

const REG = 'registry', SALES = 'sales-book', SVC = 'svc-book';
const fake = new FakeSheets();
fake.addBook(REG, { Businesses: [
  ['BusinessCode', 'BusinessName', 'SheetID', 'Active', 'App'],
  ['ABC-1', 'Test Shop', SALES, 'YES', 'SALES'],
  ['ABC-1', 'Test Shop', SVC, 'YES', 'SERVICES'],
  ['OFF-1', 'Switched Off', SALES, 'NO', 'SALES']
] });
fake.addBook(SALES, {
  Products: [['ProductID', 'Name', 'Category', 'CostPrice', 'SellingPrice', 'Stock', 'Unit']],
  Customers: [['CustomerID', 'Name', 'Phone', 'Email', 'Address', 'TotalPurchases', 'DateAdded']],
  Sales: [['SaleID', 'Date', 'CustomerID', 'CustomerName', 'Subtotal', 'Discount', 'Total', 'PaymentMethod', 'ItemsJSON', 'ReceiptID', 'ReceiptUrl']],
  SaleItems: [['SaleID', 'ProductID', 'ProductName', 'Qty', 'Price', 'LineTotal', 'CostPrice', 'Profit']],
  Config: [['Key', 'Value'], ['BusinessName', 'Test Shop'], ['Currency', 'N']]
});
fake.addBook(SVC, { Sheet1: [[]] });

const core = createCore({
  sheetsApi: fake, registryId: REG, tz: 'Africa/Lagos', ttlSeconds: 20,
  gasDir: path.join(__dirname, '..', 'gas'),
  buildPdf: async () => Buffer.from('%PDF-fake')
});
const sales = (fn, ...args) => core.call({ code: 'ABC-1', app: 'sales', fn, args });
const svc = (fn, ...args) => core.call({ code: 'ABC-1', app: 'services', fn, args });

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); process.exitCode = 1; }
}

(async () => {
  console.log('Dates');
  await test('serial <-> Date round trip in Lagos time', async () => {
    const d = new Date('2026-11-24T12:34:56Z');
    assert.equal(serialToDate(dateToSerial(d, 'Africa/Lagos'), 'Africa/Lagos').toISOString(), d.toISOString());
    assert.equal(serialToDate(46000.5, 'UTC').toISOString(), '2025-12-09T12:00:00.000Z'.replace('2025-12-09', new Date(Date.UTC(1899, 11, 30) + 46000 * 86400000).toISOString().slice(0, 10)));
  });

  console.log('Router');
  await test('session: two apps -> choose-an-app', async () => {
    const r = await core.session({ code: 'abc-1' });
    assert.equal(r.mode, 'select'); assert.deepEqual(r.apps, ['sales', 'services']); assert.equal(r.bizName, 'Test Shop');
  });
  await test('session: wrong / switched-off PIN', async () => {
    assert.equal((await core.session({ code: 'NOPE' })).mode, 'login');
    assert.equal((await core.session({ code: 'OFF-1' })).mode, 'login');
  });
  await test('session: direct app link', async () => {
    assert.equal((await core.session({ code: 'ABC-1', app: 'sales' })).mode, 'app');
  });
  await test('check: right and wrong app', async () => {
    assert.equal(await core.check({ code: 'ABC-1', app: 'sales' }), 'Test Shop');
    await assert.rejects(core.check({ code: 'NOPE', app: 'sales' }), /Invalid business code/);
  });
  await test('unknown action is refused', async () => {
    await assert.rejects(sales('deleteEverything'), /Unknown action/);
  });

  console.log('Sales app');
  let prodId, custId;
  await test('add product, then restock the same name', async () => {
    const p = await sales('addProduct', { name: 'Soap', category: 'Care', costPrice: 100, sellingPrice: 150, stock: 10, unit: 'pcs' });
    prodId = p.id; assert.equal(p.existing, false); assert.match(prodId, /^prd0001$/);
    const again = await sales('addProduct', { name: 'soap', stock: 5 });
    assert.equal(again.existing, true); assert.equal(again.stock, 15);
  });
  await test('customers: phone keeps its leading zero, same phone = same customer', async () => {
    const c = await sales('addCustomer', { name: 'Ada', phone: '08024795274' });
    custId = c.id; assert.equal(c.phone, '08024795274');
    const same = await sales('addCustomer', { name: 'Ada O', phone: '+234 802 479 5274' });
    assert.equal(same.existing, true); assert.equal(same.id, custId);
    const list = await sales('getCustomersList');
    assert.equal(list.length, 1); assert.equal(String(list[0].Phone), '08024795274');
    assert.equal(typeof list[0].DateAdded, 'string');           // dates leave as ISO text
  });
  await test('save a sale: totals, stock, sale items, customer total', async () => {
    const s = await sales('saveSale', { customerId: custId, customerName: 'Ada', items: [{ productId: prodId, name: 'Soap', qty: 2, price: 150 }], discountPercent: 10, paymentMethod: 'Cash' });
    assert.equal(s.subtotal, 300); assert.equal(s.total, 270); assert.match(s.receiptId, /^rec0001$/);
    assert.equal(fake.sheet(SALES, 'Products').cells[1][5], 13);
    assert.equal(fake.sheet(SALES, 'SaleItems').cells.length, 2);
    assert.equal((await sales('getCustomersList'))[0].TotalPurchases, 270);
  });
  await test('stock can not go below zero', async () => {
    await assert.rejects(sales('saveSale', { items: [{ productId: prodId, name: 'Soap', qty: 99, price: 150 }] }), /left in stock|out of stock/);
    assert.equal(fake.sheet(SALES, 'Products').cells[1][5], 13);
  });
  await test('history, receipt page and PDF data', async () => {
    const h = await sales('getSalesHistory', 10);
    assert.equal(h.length, 1); assert.equal(h[0].total, 270); assert.ok(!isNaN(new Date(h[0].date)));
    const html = await sales('getReceiptHtml', h[0].saleId);
    assert.match(html, /Test Shop/); assert.match(html, /rec0001/);
    const pdf = await sales('getReceiptPdf', h[0].saleId);
    assert.equal(pdf.name, 'rec0001.pdf'); assert.equal(Buffer.from(pdf.base64, 'base64').toString(), '%PDF-fake');
  });
  await test('dates survive a fresh reload from the sheet (real date cells)', async () => {
    const dateCell = fake.sheet(SALES, 'Sales').cells[1][1];
    assert.equal(typeof dateCell, 'number');                      // stored as a real Sheets date serial
    core.store.drop(SALES);
    const h = await sales('getSalesHistory', 10);
    assert.ok(Math.abs(new Date(h[0].date) - Date.now()) < 5 * 60 * 1000);
  });
  await test('three people saving at the same moment never clash', async () => {
    const jobs = [1, 2, 3].map(i => sales('saveSale', { customerName: 'Walk-in ' + i, items: [{ productId: prodId, name: 'Soap', qty: 1, price: 150 }], discount: 0, paymentMethod: 'Cash' }));
    const out = await Promise.all(jobs);
    const ids = out.map(o => o.saleId).concat(out.map(o => o.receiptId));
    assert.equal(new Set(ids).size, 6);
    assert.equal(fake.sheet(SALES, 'Products').cells[1][5], 10);
  });
  await test('a failed save to Google changes nothing and the next try works', async () => {
    fake.failNextUpdate = true;
    await assert.rejects(sales('saveSale', { items: [{ productId: prodId, name: 'Soap', qty: 1, price: 150 }] }), /simulated/);
    const before = fake.sheet(SALES, 'Sales').cells.length;
    const ok = await sales('saveSale', { items: [{ productId: prodId, name: 'Soap', qty: 1, price: 150 }], paymentMethod: 'Cash' });
    assert.equal(fake.sheet(SALES, 'Sales').cells.length, before + 1);
    assert.equal(fake.sheet(SALES, 'Products').cells[1][5], 9); assert.ok(ok.saleId);
  });
  await test('categories and running expenses (sheets created on demand)', async () => {
    const cats = await sales('getCategoriesList');
    assert.ok(cats.length > 0);
    await sales('addRunningExpense', { category: cats.find(c => String(c.Type || c.type) === 'Expense')?.Name || 'Fuel', description: 'Diesel', amount: 5000, date: '2026-11-20' });
    const exp = await sales('getRunningExpenses');
    assert.equal(exp.length, 1);
  });

  console.log('Services app');
  await test('one-time setup creates sheets and starter data', async () => {
    const msg = await core.adminSetup({ code: 'ABC-1' });
    assert.equal(msg, 'Setup complete.');
    const names = fake.books.get(SVC).sheets.map(s => s.title);
    ['Services', 'Customers', 'Sales', 'SaleItems', 'Expenses', 'Settings', 'Categories'].forEach(n => assert.ok(names.includes(n), 'missing ' + n));
    assert.ok((await svc('getAllServices')).length >= 5);
  });
  await test('record a service sale with a new customer and 10% discount', async () => {
    const services = await svc('getAllServices');
    const first = services[0];
    const sale = await svc('recordSale', {
      newCustomer: { name: 'Bola', phone: '08031234567' },
      items: [{ serviceName: first.Name, qty: 2, unitPrice: Number(first.Price) }],
      discountPercent: 10, paymentMethod: 'Cash'
    });
    assert.ok(sale.saleId || sale.SaleID, JSON.stringify(sale));
    const id = sale.saleId || sale.SaleID;
    const html = await svc('getReceiptHtml', id);
    assert.match(html, /REC0001/); assert.match(html, /Discount/);
    const pdf = await svc('getReceiptPdf', id);
    assert.equal(pdf.name, 'REC0001.pdf');
    const init = await svc('getInitData');
    assert.ok(init);
  });
  await test('expenses, reports and settings', async () => {
    await svc('addExpense', { category: 'Fuel', description: 'Generator', amount: 2500 });
    const ex = await svc('getExpenses');
    assert.equal(ex.length, 1); assert.equal(typeof ex[0].Date, 'string');
    const rep = await svc('getReportSummary', '', '');
    assert.ok(rep);
    const s = await svc('updateBusinessSettings', { BusinessName: 'Renamed Shop' });
    assert.equal(s.BusinessName, 'Renamed Shop');
  });

  console.log('Caching');
  await test('read actions reuse the cached copy; writes reload', async () => {
    const before = fake.calls.get;
    await sales('getProductsList'); await sales('getProductsList');
    const afterReads = fake.calls.get;
    assert.ok(afterReads - before <= 1);
    await sales('addProduct', { name: 'Brush', sellingPrice: 50, stock: 3 });
    assert.ok(fake.calls.get > afterReads);
  });

  console.log('\n' + passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
})();
