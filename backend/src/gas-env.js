'use strict';
// Stand-ins for the Apps Script services the original code calls
// (SpreadsheetApp, LockService, CacheService, Utilities, Session ...).
const { formatDate } = require('./tz');

function installGlobals({ store, registryId, tz, frontendUrl }) {
  const g = globalThis;
  const cache = new Map();

  g.SpreadsheetApp = {
    getActiveSpreadsheet: () => store.get(registryId),   // the registry ("Businesses") spreadsheet
    openById: id => store.get(id),
    flush() {}
  };
  // Every request runs one at a time (see core.js), so a lock is never contended.
  g.LockService = { getScriptLock: () => ({ waitLock() {}, tryLock() { return true; }, releaseLock() {} }) };
  g.CacheService = {
    getScriptCache: () => ({
      get(k) { const e = cache.get(k); if (!e) return null; if (e.exp < Date.now()) { cache.delete(k); return null; } return e.v; },
      put(k, v, secs) { cache.set(k, { v, exp: Date.now() + (secs || 600) * 1000 }); },
      remove(k) { cache.delete(k); }
    })
  };
  g.Session = { getScriptTimeZone: () => tz, getActiveUser: () => ({ getEmail: () => '' }) };
  g.Utilities = {
    formatDate: (d, z, p) => formatDate(d, z || tz, p),
    base64Encode: b => Buffer.from(b).toString('base64'),
    newBlob() { throw new Error('PDFs are built by the server (pdf.js), not by Utilities.newBlob.'); }
  };
  g.ScriptApp = { getService: () => ({ getUrl: () => frontendUrl || '/' }) };
  g.HtmlService = {};
  g.DriveApp = {
    getFoldersByName() { throw new Error('Google Drive is not used in this version.'); },
    createFolder() { throw new Error('Google Drive is not used in this version.'); }
  };
  g.Logger = { log: (...a) => console.log(...a) };
  return { clearCache: () => cache.clear() };
}

module.exports = { installGlobals };
