'use strict';
// Business registry + routing (replaces Router.gs's registryRows_ / lookupBusiness_ / session).
const { query } = require('./db');
const { clean } = require('./util');

const PAGES = { sales: true, services: true };

// All active registry rows for a code (one per app). No longer cached in-process
// (Postgres lookups are cheap and always fresh).
async function registryRows(code) {
  code = clean(code).toUpperCase();
  if (!code) throw new Error('Business code required');
  const r = await query(
    'SELECT id, name, app FROM businesses WHERE code = $1 AND active = TRUE',
    [code]
  );
  if (!r.rows.length) throw new Error('Invalid business code');
  return r.rows.map(x => ({ id: x.id, name: x.name, app: x.app }));
}

// Resolve a business row for a code + app, throwing if it doesn't exist.
async function lookupBusiness(code, app) {
  const rows = await registryRows(code);
  const appUpper = String(app || '').toUpperCase();
  const biz = rows.find(r => r.app === appUpper);
  if (!biz) throw new Error('This code is not for the ' + app + ' app');
  return biz;
}

// Same decisions the old doGet()/session() made: which page to show for a PIN.
async function session({ code, app, pick }) {
  code = clean(code);
  app = clean(app).toLowerCase();
  if (!code) return { mode: 'login' };
  try {
    const rows = await registryRows(code);
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
}

// checkBusiness() result: the business name (or throws).
async function check({ code, app }) {
  const biz = await lookupBusiness(code, app);
  return biz.name;
}

module.exports = { session, check, lookupBusiness, registryRows };
