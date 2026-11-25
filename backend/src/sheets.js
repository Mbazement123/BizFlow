'use strict';
/**
 * A small, synchronous "SpreadsheetApp" look-alike on top of the Google Sheets API.
 *
 * How it works: before an action runs, the business's spreadsheet is loaded into memory.
 * The original Apps Script code then runs unchanged against that in-memory copy
 * (getRange / getValues / setValues / appendRow ...). Every change is recorded and sent to
 * Google in ONE batchUpdate when the action finishes.
 */
const { dateToSerial, serialToDate } = require('./tz');

// Columns that hold real dates. Everything in these columns is converted to a Date on read
// and written back as a real Google Sheets date.
const DATE_HEADERS = new Set(['Date', 'DateAdded', 'CreatedAt']);
const DATE_FORMAT = { type: 'DATE_TIME', pattern: 'yyyy-mm-dd hh:mm:ss' };

const isDate = v => Object.prototype.toString.call(v) === '[object Date]';
const has = v => v !== '' && v !== null && v !== undefined;
const colNum = letters => letters.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);

function cellData(v, tz) {
  if (isDate(v)) {
    return { userEnteredValue: { numberValue: dateToSerial(v, tz) }, userEnteredFormat: { numberFormat: DATE_FORMAT }, _date: true };
  }
  if (typeof v === 'number') return isFinite(v) ? { userEnteredValue: { numberValue: v } } : {};
  if (typeof v === 'boolean') return { userEnteredValue: { boolValue: v } };
  if (v === '' || v === null || v === undefined) return {};
  return { userEnteredValue: { stringValue: String(v) } };   // text stays text (keeps leading zeros)
}

class Range {
  constructor(sheet, row, col, nr, nc) { this.sheet = sheet; this.row = row; this.col = col; this.nr = nr; this.nc = nc; }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const src = this.sheet.data[this.row - 1 + i] || [];
      const row = [];
      for (let j = 0; j < this.nc; j++) {
        const v = src[this.col - 1 + j];
        row.push(v === undefined || v === null ? '' : v);
      }
      out.push(row);
    }
    return out;
  }
  getValue() { return this.getValues()[0][0]; }
  setValues(vals) { this.sheet._write(this.row, this.col, vals); return this; }
  setValue(v) {
    const vals = [];
    for (let i = 0; i < this.nr; i++) vals.push(new Array(this.nc).fill(v));
    this.sheet._write(this.row, this.col, vals);
    return this;
  }
  setFontWeight(w) { this.sheet._bold(this, String(w).toLowerCase() === 'bold'); return this; }
  setNumberFormat() { return this; }   // text is always written as text, so nothing to do
  setBackground() { return this; }
  setFontColor() { return this; }
}

class Sheet {
  constructor(wb, id, name, rows, cols, data) {
    this.wb = wb; this.id = id; this.name = name; this.gridRows = rows; this.gridCols = cols; this.data = data;
  }
  getName() { return this.name; }
  getSheetId() { return this.id; }
  getLastRow() {
    for (let i = this.data.length - 1; i >= 0; i--) if (this.data[i].some(has)) return i + 1;
    return 0;
  }
  getLastColumn() {
    let m = 0;
    this.data.forEach(r => { for (let j = r.length - 1; j >= 0; j--) if (has(r[j])) { if (j + 1 > m) m = j + 1; break; } });
    return m;
  }
  getDataRange() { return new Range(this, 1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
  getRange(a, b, c, d) {
    if (typeof a === 'string') return this._a1(a);
    return new Range(this, a, b, c || 1, d || 1);
  }
  appendRow(arr) { this._write(this.getLastRow() + 1, 1, [arr]); return this; }
  setFrozenRows(n) {
    this.wb._op({ updateSheetProperties: { properties: { sheetId: this.id, gridProperties: { frozenRowCount: n } }, fields: 'gridProperties.frozenRowCount' } });
    return this;
  }
  _a1(s) {
    const m = /^([A-Za-z]+)(\d*)(?::([A-Za-z]+)(\d*))?$/.exec(s);
    if (!m) throw new Error('Unsupported range: ' + s);
    const c1 = colNum(m[1].toUpperCase()), r1 = +m[2] || 1;
    const c2 = m[3] ? colNum(m[3].toUpperCase()) : c1;
    const r2 = m[3] ? (+m[4] || this.gridRows) : r1;
    return new Range(this, r1, c1, r2 - r1 + 1, c2 - c1 + 1);
  }
  _ensure(rows, cols) {
    if (rows > this.gridRows) {
      const add = rows - this.gridRows + 50;
      this.wb._op({ appendDimension: { sheetId: this.id, dimension: 'ROWS', length: add } });
      this.gridRows += add;
    }
    if (cols > this.gridCols) {
      const add = cols - this.gridCols + 5;
      this.wb._op({ appendDimension: { sheetId: this.id, dimension: 'COLUMNS', length: add } });
      this.gridCols += add;
    }
  }
  _write(row, col, vals) {
    if (!vals || !vals.length) return;
    const nr = vals.length;
    const nc = Math.max.apply(null, vals.map(r => r.length));
    this._ensure(row + nr - 1, col + nc - 1);
    let anyDate = false;
    const rows = [];
    for (let i = 0; i < nr; i++) {
      while (this.data.length < row + i) this.data.push([]);
      const target = this.data[row - 1 + i];
      const cells = [];
      for (let j = 0; j < nc; j++) {
        let v = vals[i][j];
        if (v === undefined) v = '';
        while (target.length < col - 1 + j) target.push('');
        target[col - 1 + j] = v;
        const cd = cellData(v, this.wb.tz);
        if (cd._date) { anyDate = true; delete cd._date; }
        cells.push(cd);
      }
      rows.push({ values: cells });
    }
    this.wb._op({
      updateCells: {
        rows, start: { sheetId: this.id, rowIndex: row - 1, columnIndex: col - 1 },
        fields: anyDate ? 'userEnteredValue,userEnteredFormat.numberFormat' : 'userEnteredValue'
      }
    });
  }
  _bold(range, on) {
    this.wb._op({
      repeatCell: {
        range: { sheetId: this.id, startRowIndex: range.row - 1, endRowIndex: range.row - 1 + range.nr, startColumnIndex: range.col - 1, endColumnIndex: range.col - 1 + range.nc },
        cell: { userEnteredFormat: { textFormat: { bold: on } } }, fields: 'userEnteredFormat.textFormat.bold'
      }
    });
  }
}

class Workbook {
  constructor(id, tz) { this.id = id; this.tz = tz; this.sheets = []; this.ops = []; this.dirty = false; this.loadedAt = Date.now(); }
  _op(r) { this.ops.push(r); this.dirty = true; }
  getId() { return this.id; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.id + '/edit'; }
  getSheets() { return this.sheets.slice(); }
  getSheetByName(name) { return this.sheets.find(s => s.name === name) || null; }
  insertSheet(name) {
    if (this.getSheetByName(name)) throw new Error('A sheet with the name "' + name + '" already exists.');
    const id = Math.floor(Math.random() * 2000000000) + 1000;
    this._op({ addSheet: { properties: { sheetId: id, title: name, gridProperties: { rowCount: 1000, columnCount: 26 } } } });
    const s = new Sheet(this, id, name, 1000, 26, []);
    this.sheets.push(s);
    return s;
  }
}

class SheetStore {
  /** api = googleapis sheets client; opts: { registryId, ttlSeconds, registryTtlSeconds, tz } */
  constructor(api, opts) {
    this.api = api;
    this.registryId = opts.registryId;
    this.ttl = (opts.ttlSeconds == null ? 20 : opts.ttlSeconds) * 1000;
    this.registryTtl = (opts.registryTtlSeconds == null ? 600 : opts.registryTtlSeconds) * 1000;
    this.tz = opts.tz || 'Africa/Lagos';
    this.map = new Map();
  }
  async load(id, opts) {
    const c = this.map.get(id);
    const ttl = id === this.registryId ? this.registryTtl : this.ttl;
    if (c && !c.dirty && !(opts && opts.fresh) && Date.now() - c.loadedAt < ttl) return c;
    const wb = await this._fetch(id);
    this.map.set(id, wb);
    return wb;
  }
  get(id) {
    const c = this.map.get(id);
    if (!c) throw new Error('Spreadsheet not loaded: ' + id);
    return c;
  }
  drop(id) { this.map.delete(id); }
  async commit(wb) {
    if (!wb.ops.length) { wb.dirty = false; return; }
    try {
      await this.api.spreadsheets.batchUpdate({ spreadsheetId: wb.id, requestBody: { requests: wb.ops } });
      wb.ops = [];
      wb.dirty = false;
    } catch (e) {
      this.drop(wb.id);   // memory no longer matches the sheet: reload next time
      throw e;
    }
  }
  async _fetch(id) {
    const meta = await this.api.spreadsheets.get({
      spreadsheetId: id,
      fields: 'properties.timeZone,sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))'
    });
    const props = (meta.data.sheets || []).map(s => s.properties);
    const tz = (meta.data.properties && meta.data.properties.timeZone) || this.tz;
    const wb = new Workbook(id, tz);
    if (props.length) {
      const res = await this.api.spreadsheets.values.batchGet({
        spreadsheetId: id,
        ranges: props.map(p => "'" + p.title.replace(/'/g, "''") + "'"),
        valueRenderOption: 'UNFORMATTED_VALUE',
        dateTimeRenderOption: 'SERIAL_NUMBER'
      });
      props.forEach((p, i) => {
        const raw = ((res.data.valueRanges[i] || {}).values || []).map(r => r.slice());
        convertDates(raw, tz);
        wb.sheets.push(new Sheet(wb, p.sheetId, p.title, p.gridProperties.rowCount, p.gridProperties.columnCount, raw));
      });
    }
    return wb;
  }
}

function convertDates(raw, tz) {
  const headers = raw[0] || [];
  const idx = [];
  headers.forEach((h, j) => { if (DATE_HEADERS.has(String(h))) idx.push(j); });
  if (!idx.length) return;
  for (let r = 1; r < raw.length; r++) {
    idx.forEach(j => { if (typeof raw[r][j] === 'number') raw[r][j] = serialToDate(raw[r][j], tz); });
  }
}

module.exports = { SheetStore, Workbook, Sheet, Range };
