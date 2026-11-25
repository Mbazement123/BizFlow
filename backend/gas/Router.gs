/**
 * ROUTER — one web app, two apps (Sales + Services), many businesses
 * ------------------------------------------------------------------
 * Registry sheet (in THIS script's bound spreadsheet), named "Businesses":
 *   BusinessCode | BusinessName | SheetID | Active | App
 *   K7X2-M9QP    | Clean Pro    | 1xYz... | YES    | SALES
 *   K7X2-M9QP    | Clean Pro    | 1AbC... | YES    | SERVICES
 *
 *  - Active: blank or YES = on, NO = off
 *  - App:    SALES or SERVICES (blank = SALES)
 *  - A business that uses BOTH apps gets two rows with the SAME code (one per app,
 *    each with that app's own spreadsheet). After signing in it can choose either.
 *
 * Links:
 *   <exec url>                  -> home page: sign in with the PIN, then choose an app
 *   <exec url>?b=PIN            -> opens the app directly when the PIN has only one app,
 *                                  otherwise the choose-an-app page
 *   <exec url>?app=sales&b=PIN  -> opens that app directly
 */

// Name shown at the top of the home page (change it to your own)
const APP_NAME = 'Soft Manager';

// Set at the start of every request by useBusiness_()
let SS = null;
let BIZ_NAME = '';

const REGISTRY_SHEET = 'Businesses';

// ---------------------------------------------------------------
// WEB APP ENTRY POINT
// ---------------------------------------------------------------
function doGet(e) {
  const p = (e && e.parameter) || {};
  const clean = s => String(s || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  const code = clean(p.b);
  let app = clean(p.app).toLowerCase();

  const pages = {
    sales: ['SalesApp', 'Soft Sales'],
    services: ['ServicesApp', 'Soft Services']
  };

  let page = null;
  let mode = 'login';        // 'login' = sign-in card, 'select' = choose-an-app links
  let error = '';
  let apps = [];
  let bizName = '';

  if (code) {
    try {
      const rows = registryRows_(code);           // throws if the PIN is wrong or switched off
      bizName = rows[0].name;
      rows.forEach(r => {
        const a = r.app.toLowerCase();
        if (pages[a] && apps.indexOf(a) === -1) apps.push(a);
      });
      if (app) {
        if (apps.indexOf(app) === -1) throw new Error('wrong app');
        page = pages[app];
      } else if (apps.length === 1 && !p.pick) {
        app = apps[0];
        page = pages[app];
      } else {
        mode = 'select';
      }
    } catch (err) {
      error = 'Wrong PIN. Check it and try again.';
      mode = 'login';
      apps = [];
    }
  }

  const t = HtmlService.createTemplateFromFile(page ? page[0] : 'Index');
  t.urlCode = code;
  t.baseUrl = ScriptApp.getService().getUrl();
  t.error = error;
  t.mode = mode;
  t.apps = apps;
  t.bizName = bizName;
  t.appName = APP_NAME;
  return t.evaluate()
    .setTitle(page ? page[1] : APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ---------------------------------------------------------------
// MULTI-BUSINESS ROUTING
// ---------------------------------------------------------------
/**
 * All active registry rows for a code (one per app). Cached for 10 minutes
 * (so switching a business off can take up to 10 minutes to apply).
 */
function registryRows_(code) {
  code = String(code || '').trim().toUpperCase();
  if (!code) throw new Error('Business code required');

  const cache = CacheService.getScriptCache();
  const hit = cache.get('reg:' + code);
  if (hit) return JSON.parse(hit);

  const reg = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(REGISTRY_SHEET);
  if (!reg) throw new Error('Missing sheet: ' + REGISTRY_SHEET);
  const rows = reg.getDataRange().getValues().slice(1)
    .filter(r => String(r[0]).trim().toUpperCase() === code &&
                 String(r[3]).trim().toUpperCase() !== 'NO')
    .map(r => ({
      id: String(r[2]).trim(),
      name: String(r[1]).trim(),
      app: String(r[4] || 'SALES').trim().toUpperCase()
    }));
  if (!rows.length) throw new Error('Invalid business code');
  cache.put('reg:' + code, JSON.stringify(rows), 600);
  return rows;
}

function lookupBusiness_(code, app) {
  const rows = registryRows_(code);
  const biz = rows.find(r => r.app === String(app || '').toUpperCase());
  if (!biz) throw new Error('This code is not for the ' + app + ' app');
  return biz;
}

/** Points SS at the business's sheet for that app. */
function useBusiness_(code, app) {
  const biz = lookupBusiness_(code, app);
  SS = SpreadsheetApp.openById(biz.id);
  BIZ_NAME = biz.name;
}

// Used by the chooser page and the Sales login box to validate a code
function checkBusiness(code, app) {
  useBusiness_(code, app);
  return BIZ_NAME;
}

/** Whitelist of what each app's page may call. Names on the left are what the page uses. */
function actions_() {
  return {
    sales: {
      getProductsList, getCustomersList, getExpensesList, addProduct, saveSale, getSalesHistory,
      getCategoriesList, addRunningExpense, getRunningExpenses,
      addCategory: sales_addCategory,
      updateCategory: sales_updateCategory,
      generateReceiptPdf,
      getReceiptPdf: sales_getReceiptPdf,
      getConfig: sales_getConfig,
      addCustomer: sales_addCustomer,
      getReceiptHtml: sales_getReceiptHtml
    },
    services: {
      getInitData: svc_getInitData,
      getReportSummary,
      addCustomer: svc_addCustomer,
      getReceiptHtml: svc_getReceiptHtml,
      searchCustomers, findCustomerByPhone, getCustomersWithSpend, getCustomerHistory,
      recordSale, getReceiptPdf, addExpense, getExpenses,
      updateBusinessSettings, getAllServices, addService, updateService,
      getAllCategories, addCategory, updateCategory
    }
  };
}

/** The ONLY function either page calls for data. */
function api(code, app, fn, args) {
  app = String(app || '').toLowerCase();
  useBusiness_(code, app);
  const table = actions_()[app];
  if (!table || !Object.prototype.hasOwnProperty.call(table, fn)) {
    throw new Error('Unknown action: ' + fn);
  }
  return table[fn].apply(null, args || []);
}

/**
 * Run ONCE per new Services business, from the Apps Script editor:
 * change 'THECODE' below to the business code, then Run > setupBusiness.
 * (The business must already have a row in the Businesses registry.)
 */
function setupBusiness() {
  useBusiness_('THECODE', 'services');
  return setupSpreadsheet();
}
