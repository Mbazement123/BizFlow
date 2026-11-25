'use strict';
// A tiny in-memory imitation of the Google Sheets API (only what the app uses).
// It is deliberately strict (e.g. it rejects writes beyond the sheet's grid) so mistakes show up in tests.
class FakeSheets {
  constructor() { this.books = new Map(); this.calls = { get: 0, batchGet: 0, batchUpdate: 0 }; this.failNextUpdate = false; }

  addBook(id, sheets, tz) {
    const book = { tz: tz || 'Africa/Lagos', sheets: [] };
    Object.keys(sheets).forEach((title, i) => {
      const rows = sheets[title];
      book.sheets.push({ sheetId: 100 + i, title, rowCount: Math.max(rows.length, 3), columnCount: 12, cells: rows.map(r => r.slice()) });
    });
    this.books.set(id, book);
    return book;
  }
  sheet(id, title) { return this.books.get(id).sheets.find(s => s.title === title); }

  get spreadsheets() {
    const self = this;
    const book = id => { const b = self.books.get(id); if (!b) { const e = new Error('Requested entity was not found.'); e.code = 404; throw e; } return b; };
    return {
      get: async ({ spreadsheetId }) => {
        self.calls.get++;
        const b = book(spreadsheetId);
        return { data: { properties: { timeZone: b.tz }, sheets: b.sheets.map(s => ({ properties: { sheetId: s.sheetId, title: s.title, gridProperties: { rowCount: s.rowCount, columnCount: s.columnCount } } })) } };
      },
      values: {
        batchGet: async ({ spreadsheetId, ranges }) => {
          self.calls.batchGet++;
          const b = book(spreadsheetId);
          return { data: { valueRanges: ranges.map(r => {
            const title = r.replace(/^'|'$/g, '').replace(/''/g, "'");
            const s = b.sheets.find(x => x.title === title);
            const rows = s.cells.map(row => { const out = row.slice(); while (out.length && (out[out.length - 1] === null || out[out.length - 1] === undefined || out[out.length - 1] === '')) out.pop(); return out; });
            while (rows.length && !rows[rows.length - 1].length) rows.pop();
            return { values: rows.length ? rows : undefined };
          }) } };
        }
      },
      batchUpdate: async ({ spreadsheetId, requestBody }) => {
        self.calls.batchUpdate++;
        if (self.failNextUpdate) { self.failNextUpdate = false; throw new Error('simulated Google outage'); }
        const b = book(spreadsheetId);
        const snapshot = JSON.stringify(b);
        try {
          requestBody.requests.forEach(rq => {
            if (rq.addSheet) {
              const p = rq.addSheet.properties;
              if (b.sheets.find(s => s.title === p.title)) throw new Error('Sheet exists: ' + p.title);
              b.sheets.push({ sheetId: p.sheetId, title: p.title, rowCount: p.gridProperties.rowCount, columnCount: p.gridProperties.columnCount, cells: [] });
            } else if (rq.appendDimension) {
              const s = b.sheets.find(x => x.sheetId === rq.appendDimension.sheetId);
              if (rq.appendDimension.dimension === 'ROWS') s.rowCount += rq.appendDimension.length; else s.columnCount += rq.appendDimension.length;
            } else if (rq.updateCells) {
              const u = rq.updateCells, s = b.sheets.find(x => x.sheetId === u.start.sheetId);
              if (!s) throw new Error('No such sheetId ' + u.start.sheetId);
              u.rows.forEach((row, i) => row.values.forEach((cell, j) => {
                const r = u.start.rowIndex + i, c = u.start.columnIndex + j;
                if (r >= s.rowCount || c >= s.columnCount) throw new Error('Write outside the grid: ' + s.title + ' r' + r + ' c' + c);
                while (s.cells.length <= r) s.cells.push([]);
                while (s.cells[r].length <= c) s.cells[r].push(null);
                const v = cell.userEnteredValue;
                s.cells[r][c] = !v ? null : ('numberValue' in v ? v.numberValue : 'boolValue' in v ? v.boolValue : v.stringValue);
              }));
            } else if (rq.repeatCell || rq.updateSheetProperties) {
              // formatting only: nothing to store in this fake
            } else {
              throw new Error('Unsupported request: ' + Object.keys(rq)[0]);
            }
          });
        } catch (e) {
          self.books.set(spreadsheetId, JSON.parse(snapshot));   // the real API is all-or-nothing too
          throw e;
        }
        return { data: {} };
      }
    };
  }
}
module.exports = { FakeSheets };
