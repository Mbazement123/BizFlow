'use strict';
/**
 * The brain of the backend: runs the original Apps Script actions, one request at a time.
 *
 *  - Requests are queued, so two people saving at once never clash (same promise Apps Script's
 *    script lock gave you).
 *  - Reading actions (get..., find..., search...) may use a short in-memory copy of the sheet.
 *    Writing actions always reload the sheet first, so manual edits in Google Sheets are never overwritten.
 *  - Writing actions are all-or-nothing: if anything fails, nothing is saved.
 */
const { installGlobals } = require('./gas-env');
const { loadGas } = require('./gas-loader');
const { SheetStore } = require('./sheets');

const PAGES = { sales: true, services: true };
const clean = s => String(s || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
const isRead = fn => /^(get|find|search)/.test(String(fn || ''));

function friendly(e) {
  const code = e && (e.code || (e.response && e.response.status));
  if (code === 403 || code === 404) {
    return 'The server cannot open this business sheet. Share the sheet with the service account (Editor) and check the SheetID.';
  }
  if (code === 429) return 'Google is busy right now. Please try again in a moment.';
  return (e && e.message) || 'Something went wrong.';
}

function createCore({ sheetsApi, registryId, tz, ttlSeconds, gasDir, buildPdf, frontendUrl }) {
  const store = new SheetStore(sheetsApi, { registryId, ttlSeconds, tz });
  installGlobals({ store, registryId, tz, frontendUrl });
  loadGas(gasDir);

  let chain = Promise.resolve();
  function enqueue(task) {
    const run = chain.then(task, task);
    chain = run.catch(() => {});
    return run;
  }

  async function withBusiness(code, app, fresh, fn) {
    await store.load(registryId);
    let biz;
    try { biz = globalThis.lookupBusiness_(code, app); } catch (e) { throw new Error(e.message); }
    const wb = await store.load(biz.id, { fresh });
    try {
      const out = await fn(wb, biz);
      await store.commit(wb);
      return out;
    } catch (e) {
      if (wb.dirty) store.drop(biz.id);   // throw away half-finished changes
      throw e;
    }
  }

  return {
    store,

    /** Same decisions the old doGet() made: which page to show for a PIN. */
    session({ code, app, pick }) {
      return enqueue(async () => {
        code = clean(code); app = clean(app).toLowerCase();
        if (!code) return { mode: 'login' };
        try {
          await store.load(registryId);
          const rows = globalThis.registryRows_(code);
          const apps = [];
          rows.forEach(r => { const a = r.app.toLowerCase(); if (PAGES[a] && !apps.includes(a)) apps.push(a); });
          const base = { apps, bizName: rows[0].name };
          if (app) {
            if (!apps.includes(app)) throw new Error('wrong app');
            return Object.assign({ mode: 'app', app }, base);
          }
          if (apps.length === 1 && !pick) return Object.assign({ mode: 'app', app: apps[0] }, base);
          return Object.assign({ mode: 'select' }, base);
        } catch (e) {
          return { mode: 'login', error: 'Wrong PIN. Check it and try again.' };
        }
      });
    },

    check({ code, app }) {
      return enqueue(async () => {
        try {
          return await withBusiness(String(code || ''), String(app || '').toLowerCase(), false,
            () => globalThis.checkBusiness(code, String(app || '').toLowerCase()));
        } catch (e) { throw new Error(friendly(e)); }
      });
    },

    call({ code, app, fn, args }) {
      return enqueue(async () => {
        app = String(app || '').toLowerCase();
        try {
          const result = await withBusiness(String(code || ''), app, !isRead(fn),
            () => globalThis.api(code, app, fn, Array.isArray(args) ? args : []));
          if (result && result.__pdf) {
            const buf = await buildPdf(Object.assign({ tz }, result.__pdf));
            const out = Object.assign({}, result, { base64: buf.toString('base64') });
            delete out.__pdf;
            return out;
          }
          return result;
        } catch (e) { throw new Error(friendly(e)); }
      });
    },

    /** One-time setup of a new Services business sheet (replaces running setupBusiness in the editor). */
    adminSetup({ code }) {
      return enqueue(async () => {
        try {
          return await withBusiness(String(code || ''), 'services', true, () => {
            globalThis.useBusiness_(code, 'services');
            return globalThis.setupSpreadsheet();
          });
        } catch (e) { throw new Error(friendly(e)); }
      });
    }
  };
}

module.exports = { createCore };
