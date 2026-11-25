'use strict';
// Draws a narrow (80 mm) receipt PDF, matching the on-screen receipt layout.
const path = require('path');
const PDFDocument = require('pdfkit');
const { formatDate } = require('./tz');

const REG = path.join(__dirname, '..', 'fonts', 'DejaVuSans.ttf');
const BOLD = path.join(__dirname, '..', 'fonts', 'DejaVuSans-Bold.ttf');
const W = 226.77, M = 14, IW = W - 2 * M;

function setup(height) {
  const doc = new PDFDocument({ autoFirstPage: false, compress: true });
  doc.registerFont('R', REG);
  doc.registerFont('B', BOLD);
  doc.addPage({ size: [W, height], margin: 0 });
  return doc;
}

function draw(doc, { sale, config, tz }) {
  const cur = config.Currency || '';
  const money = n => cur + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const when = formatDate(new Date(sale.date), tz, 'dd MMM yyyy, h:mm a');
  let y = M;

  const center = (t, size, bold, color) => {
    doc.font(bold ? 'B' : 'R').fontSize(size).fillColor(color || '#111');
    doc.text(String(t), M, y, { width: IW, align: 'center' });
    y = doc.y + 3;
  };
  const line = dashed => {
    y += 4;
    doc.save().lineWidth(0.7).strokeColor('#888');
    if (dashed) doc.dash(2, { space: 2 });
    doc.moveTo(M, y).lineTo(W - M, y).stroke().undash().restore();
    y += 8;
  };
  const pair = (l, r, o) => {
    o = o || {};
    const lw = IW * (o.leftW || 0.45), size = o.size || 8.5, top = y;
    doc.font(o.leftBold ? 'B' : 'R').fontSize(size).fillColor(o.leftColor || '#111').text(String(l), M, top, { width: lw });
    const ly = doc.y;
    doc.font(o.rightBold ? 'B' : 'R').fontSize(size).fillColor('#111').text(String(r), M + lw, top, { width: IW - lw, align: 'right' });
    y = Math.max(ly, doc.y) + (o.gap == null ? 3 : o.gap);
  };

  center(config.BusinessName || 'Sales Receipt', 15, true);
  if (config.Address) center(config.Address, 8.5, false, '#444');
  if (config.Phone) center(config.Phone, 8.5, false, '#444');
  line(true);

  const meta = { size: 8.5, leftColor: '#555', rightBold: true, leftW: 0.38 };
  pair('Receipt No', sale.receiptId, meta);
  pair('Date', when, meta);
  pair('Customer', sale.customerName || 'Walk-in', meta);
  if (sale.customerPhone) pair('Phone', sale.customerPhone, meta);
  pair('Payment', sale.paymentMethod, meta);
  line(true);

  (sale.items || []).forEach(it => {
    center_left(it.name);
    pair(it.qty + ' \u00D7 ' + money(it.price), money(Number(it.qty) * Number(it.price)), { size: 8.5, leftW: 0.62, gap: 5 });
    doc.save().lineWidth(0.5).strokeColor('#bbb').dash(1, { space: 2 }).moveTo(M, y).lineTo(W - M, y).stroke().undash().restore();
    y += 6;
  });
  function center_left(t) {
    doc.font('B').fontSize(9.5).fillColor('#111').text(String(t), M, y, { width: IW });
    y = doc.y + 2;
  }

  line(true);
  pair('Subtotal', money(sale.subtotal), { size: 9, leftW: 0.5 });
  if (Number(sale.discount)) {
    const pct = Number(sale.discountPercent) ? ' (' + Number(sale.discountPercent) + '%)' : '';
    pair('Discount' + pct, '-' + money(sale.discount), { size: 9, leftW: 0.5 });
  }
  y += 2;
  doc.save().lineWidth(1.4).strokeColor('#111').moveTo(M, y).lineTo(W - M, y).stroke().restore();
  y += 6;
  pair('TOTAL', money(sale.total), { size: 12, leftBold: true, rightBold: true, leftW: 0.4 });
  y += 10;
  center(config.Footer || 'Thank you!', 8.5, false, '#444');
  return y;
}

function buildPdf(data) {
  // pass 1: measure the height; pass 2: draw on a page of exactly that height
  const probe = setup(6000);
  const height = Math.ceil(draw(probe, data)) + 24;
  probe.on('data', () => {});
  probe.end();

  const doc = setup(height);
  const chunks = [];
  return new Promise((resolve, reject) => {
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    draw(doc, data);
    doc.end();
  });
}

module.exports = { buildPdf };
