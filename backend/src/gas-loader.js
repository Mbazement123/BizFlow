'use strict';
// Loads the ORIGINAL Apps Script files (backend/gas/*.gs) unchanged, so the business
// logic is exactly what already runs for you today.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadGas(dir) {
  ['Router.gs', 'Sales.gs', 'Services.gs'].forEach(f => {
    vm.runInThisContext(fs.readFileSync(path.join(dir, f), 'utf8'), { filename: f });
  });
  installOverrides();
}

// The only three functions that cannot run unchanged: they turned HTML into a PDF with
// Apps Script's converter (and one saved it to Drive). Here they just hand the receipt
// data back, and pdf.js draws the PDF.
function installOverrides() {
  const g = globalThis;
  g.sales_getReceiptPdf = function (saleId) {
    const sale = g.getSaleById(saleId);
    g.ensureReceiptId_(sale);
    return { name: sale.receiptId + '.pdf', __pdf: { sale: sale, config: g.sales_getConfig() } };
  };
  g.generateReceiptPdf = function (saleId) {
    const r = g.sales_getReceiptPdf(saleId);
    r.receiptId = r.__pdf.sale.receiptId;
    r.url = '';
    return r;
  };
  g.getReceiptPdf = function (saleId) {
    const r = g.getReceipt(saleId);
    return { name: r.receiptNo + '.pdf', __pdf: { sale: g.toReceiptSale_(r), config: g.svc_getConfig() } };
  };
}

module.exports = { loadGas };
