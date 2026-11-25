  // ---------------- BUSINESS CODE (multi-business) ----------------
  const BIZ_CODE = (new URLSearchParams(location.search).get('b') || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);   // from the ?b=CODE link
  const HOME_URL = '/';   // the home / chooser page

  // Access requires a password session (email + password login). Without it, go log in.
  function hasSession() {
    try { return Boolean(localStorage.getItem('bizSession')); } catch (e) { return false; }
  }
  function goLogin() {
    try { localStorage.removeItem('bizSession'); localStorage.removeItem('bizCode'); } catch (e) {}
    window.top.location.href = HOME_URL;
  }
  if (!hasSession()) goLogin();

  // Keeps the google.script.run chain style, but sends the business code and app with every call
  function bizRun() {
    let ok = null, fail = null;
    const p = new Proxy({}, {
      get(_, name) {
        if (name === 'withSuccessHandler') return f => { ok = f; return p; };
        if (name === 'withFailureHandler') return f => { fail = f; return p; };
        return (...args) => {
          let r = google.script.run;
          if (ok) r = r.withSuccessHandler(ok);
          if (fail) r = r.withFailureHandler(fail);
          r.api(BIZ_CODE, 'services', String(name), args);
        };
      }
    });
    return p;
  }

  function switchBusiness() {
    window.top.location.href = HOME_URL;
  }

  let STATE = {
    services: [],
    settings: {},
    saleItems: [],
    selectedCustomer: null,
    pendingNewCustomer: null
  };

  document.getElementById('hdrDate').textContent = new Date().toLocaleDateString();
  document.getElementById('expDate').valueAsDate = new Date();

  if (hasSession()) bizRun().withSuccessHandler(onInitData).withFailureHandler(onError).getInitData();

  function onInitData(data) {
    STATE.services = data.services || [];
    STATE.settings = data.settings || {};
    document.getElementById('hdrBiz').textContent = STATE.settings.BusinessName || 'Services';
    STATE.categories = data.categories || [];
    populateServiceSelect();
    populateSettingsForm();
    populateExpenseCategories();
  }

  function populateExpenseCategories() {
    const sel = document.getElementById('expCategory');
    const keep = sel.value;
    let names = (STATE.categories || []).map(c => c.Name);
    if (names.length === 0) names = ['Other'];
    sel.innerHTML = names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
    if (names.includes(keep)) sel.value = keep;
  }

  function onError(err) {
    const m = (err && err.message) ? err.message : 'Something went wrong.';
    if (/log in|session/i.test(m)) { goLogin(); return; }
    showToast(m);
  }

  function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2200);
  }

  function currency(n) {
    const sym = STATE.settings.Currency || '';
    n = Number(n || 0);
    return sym + n.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
  }

  // ---------- Tabs ----------
  function showScreen(name) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById('screen-' + name).classList.add('active');
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.screen === name));
    const titles = { sale: 'New Sale', customers: 'Customers', expenses: 'Expenses', reports: 'Reports', settings: 'Settings' };
    document.getElementById('hdrTitle').textContent = titles[name];
    if (name === 'expenses') loadExpenses();
    if (name === 'reports') {
      if (!REPORT_READY) { REPORT_READY = true; setRepRange('today'); } else loadReport();
    }
    if (name === 'customers') loadCustomerList();
    if (name === 'settings') { loadServicesManagement(); loadCategoriesManagement(); }
  }

  // ---------- New Sale: customer ----------
  let searchTimer = null;
  let SALE_HITS = [];

  function onCustomerSearch() {
    clearTimeout(searchTimer);
    const q = document.getElementById('customerSearch').value.trim();
    if (!q) { document.getElementById('customerResults').innerHTML = ''; return; }
    searchTimer = setTimeout(() => {
      bizRun().withSuccessHandler(renderCustomerResults).withFailureHandler(onError).searchCustomers(q);
    }, 300);
  }

  function renderCustomerResults(list) {
    const box = document.getElementById('customerResults');
    SALE_HITS = list || [];
    if (SALE_HITS.length === 0) {
      box.innerHTML = '<div class="muted" style="padding:6px 0;">No customer found. Use "+ New Customer" below to add one.</div>';
      return;
    }
    box.innerHTML = SALE_HITS.map((c, i) =>
      `<div class="customer-hit" onclick="pickCustomerAt(${i})">
        <b>${escapeHtml(c.Name)}</b><small>${escapeHtml(c.Phone || '')}</small>
      </div>`).join('');
  }

  function pickCustomerAt(i) { pickCustomer(SALE_HITS[i]); }

  function pickCustomer(c) {
    STATE.selectedCustomer = c;
    document.getElementById('selCustName').textContent = c.Name;
    document.getElementById('selCustPhone').textContent = c.Phone || '';
    document.getElementById('selectedCustomerBox').style.display = 'block';
    document.getElementById('customerSearchBox').style.display = 'none';
  }

  function clearCustomer() {
    STATE.selectedCustomer = null;
    STATE.pendingNewCustomer = null;
    document.getElementById('selectedCustomerBox').style.display = 'none';
    document.getElementById('customerSearchBox').style.display = 'block';
    document.getElementById('customerSearch').value = '';
    document.getElementById('customerResults').innerHTML = '';
  }

  function openNewCustomerForm() {
    const q = document.getElementById('customerSearch').value.trim();
    if (q) {
      if (/^[\d+\s()-]+$/.test(q)) document.getElementById('ncPhone').value = q;
      else document.getElementById('ncName').value = q;
    }
    document.getElementById('newCustomerForm').style.display = 'block';
  }
  function cancelNewCustomer() {
    document.getElementById('newCustomerForm').style.display = 'none';
  }

  function hidePhoneWarning() {
    document.getElementById('ncPhoneWarning').style.display = 'none';
  }

  // Phone number is the unique identifier for a customer. As soon as the
  // cashier leaves the phone field, check the server for a match so we
  // never create a second record for the same number.
  function checkPhoneDuplicate() {
    const phone = document.getElementById('ncPhone').value.trim();
    const warn = document.getElementById('ncPhoneWarning');
    if (!phone) { warn.style.display = 'none'; return; }
    bizRun().withSuccessHandler(existing => {
      if (existing) {
        warn.textContent = 'Already registered to ' + existing.Name + ' — saving will use that customer, not create a new one.';
        warn.style.display = 'block';
      } else {
        warn.style.display = 'none';
      }
    }).withFailureHandler(() => {}).findCustomerByPhone(phone);
  }

  function confirmNewCustomer() {
    const name = document.getElementById('ncName').value.trim();
    const phone = document.getElementById('ncPhone').value.trim();
    const address = document.getElementById('ncAddress').value.trim();
    if (!phone) { showToast('Phone number is required.'); return; }
    if (!name) { showToast('Enter a customer name.'); return; }
    bizRun().withSuccessHandler(existing => {
      if (existing) {
        showToast('Phone already registered - using ' + existing.Name + '.');
        pickCustomer(existing);
        document.getElementById('newCustomerForm').style.display = 'none';
      } else {
        finalizeNewCustomer(name, phone, address);
      }
    }).withFailureHandler(onError).findCustomerByPhone(phone);
  }

  function finalizeNewCustomer(name, phone, address) {
    STATE.pendingNewCustomer = { name, phone, address };
    pickCustomer({ Name: name, Phone: phone, __pending: true });
    document.getElementById('newCustomerForm').style.display = 'none';
  }

  // ---------- New Sale: items ----------
  function populateServiceSelect() {
    const sel = document.getElementById('serviceSelect');
    sel.innerHTML = STATE.services.map(s => `<option value="${escapeHtml(s.Name)}" data-price="${s.Price}">${escapeHtml(s.Name)}</option>`).join('');
    sel.onchange = () => { document.getElementById('servicePrice').value = sel.selectedOptions[0]?.dataset.price || 0; };
    if (STATE.services.length) document.getElementById('servicePrice').value = STATE.services[0].Price;
  }

  function addItem() {
    const sel = document.getElementById('serviceSelect');
    const name = sel.value;
    const qty = Number(document.getElementById('serviceQty').value) || 1;
    const price = Number(document.getElementById('servicePrice').value) || 0;
    if (!name) { showToast('Pick a service.'); return; }
    STATE.saleItems.push({ serviceName: name, qty, unitPrice: price });
    renderSaleItems();
  }

  function removeItem(idx) {
    STATE.saleItems.splice(idx, 1);
    renderSaleItems();
  }

  function renderSaleItems() {
    const box = document.getElementById('saleItems');
    if (STATE.saleItems.length === 0) {
      box.innerHTML = '<div class="empty">No services added yet.</div>';
    } else {
      box.innerHTML = STATE.saleItems.map((it, i) => `
        <div class="item-row">
          <div class="name">${escapeHtml(it.serviceName)}<div class="muted">${it.qty} × ${currency(it.unitPrice)}</div></div>
          <div>${currency(it.qty * it.unitPrice)}</div>
          <button class="btn-danger btn-small" onclick="removeItem(${i})">✕</button>
        </div>`).join('');
    }
    renderTotals();
  }

  function getDiscountPercent() {
    let pct = Number(document.getElementById('discountInput').value) || 0;
    return Math.min(Math.max(pct, 0), 100);
  }

  function renderTotals() {
    const subtotal = STATE.saleItems.reduce((s, it) => s + it.qty * it.unitPrice, 0);
    const pct = getDiscountPercent();
    const discount = Math.round(subtotal * pct) / 100;
    const total = Math.max(subtotal - discount, 0);
    document.getElementById('discLabel').textContent = 'Discount' + (pct ? ' (' + pct + '%)' : '');
    document.getElementById('sumDiscount').textContent = (discount ? '-' : '') + currency(discount);
    document.getElementById('sumSubtotal').textContent = currency(subtotal);
    document.getElementById('sumTotal').textContent = currency(total);
  }

  function submitSale() {
    if (STATE.saleItems.length === 0) { showToast('Add at least one service.'); return; }
    const payload = {
      items: STATE.saleItems,
      discountPercent: getDiscountPercent(),
      paymentMethod: document.getElementById('paymentMethod').value
    };
    if (STATE.selectedCustomer) {
      if (STATE.selectedCustomer.__pending) {
        payload.newCustomer = STATE.pendingNewCustomer;
      } else {
        payload.customerId = STATE.selectedCustomer.CustomerID;
        payload.customerName = STATE.selectedCustomer.Name;
        payload.customerPhone = STATE.selectedCustomer.Phone;
      }
    }
    bizRun().withSuccessHandler(onSaleSaved).withFailureHandler(onError).recordSale(payload);
  }

  function onSaleSaved(res) {
    if (!res) { showToast('Sale saved, but the receipt could not load. Open it from Reports.'); return; }
    showToast('Sale saved.');
    showReceipt(res.saleId, res.receiptHtml, true);
    // reset form
    STATE.saleItems = [];
    clearCustomer();
    document.getElementById('discountInput').value = 0;
    renderSaleItems();
  }

  // ---------- Receipt (HTML built on the server from your template) ----------
  let CURRENT_RECEIPT = { saleId: null, html: '', isNew: false, pdfPromise: null };
  let AWAITING_PRINT = false;

  // isNew = the receipt of the sale just saved. Once it has been printed,
  // shared or dismissed, the app goes back to a fresh, empty Sale page.
  function showReceipt(saleId, html, isNew) {
    CURRENT_RECEIPT = { saleId, html, isNew: !!isNew, pdfPromise: null };
    prefetchPdf(CURRENT_RECEIPT);
    const f = document.getElementById('receiptFrame');
    f.onload = () => {
      // Grow the frame to the full receipt so every line shows without scrolling.
      try { f.style.height = (f.contentDocument.documentElement.scrollHeight + 8) + 'px'; } catch (e) {}
    };
    f.srcdoc = html;
    document.getElementById('receiptModal').classList.add('open');
  }

  function openReceipt(saleId) {
    showToast('Loading receipt...');
    bizRun().withSuccessHandler(html => showReceipt(saleId, html, false))
      .withFailureHandler(onError).getReceiptHtml(saleId);
  }

  // Build the PDF in the background so Share is instant when tapped
  // (phones only allow the share sheet right after a tap).
  function requestPdf(saleId) {
    return new Promise((resolve, reject) => {
      bizRun().withSuccessHandler(resolve).withFailureHandler(reject).getReceiptPdf(saleId);
    });
  }
  function prefetchPdf(cur) {
    cur.pdfPromise = requestPdf(cur.saleId);
    cur.pdfPromise.catch(() => {});
  }

  // Prints the receipt itself: the @media print rules above hide the rest of the screen.
  function printReceipt() {
    AWAITING_PRINT = true;
    window.print();
  }
  window.addEventListener('afterprint', () => {
    if (AWAITING_PRINT) { AWAITING_PRINT = false; finishReceipt(); }
  });

  function pdfToBlob(res) {
    const bin = atob(res.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: 'application/pdf' });
  }

  async function shareReceipt() {
    const cur = CURRENT_RECEIPT;
    if (!cur.saleId) return;
    showToast('Preparing receipt...');
    let res;
    try {
      res = await cur.pdfPromise;
    } catch (e) {
      try { res = await requestPdf(cur.saleId); } catch (err) { onError(err); return; }
    }
    const blob = pdfToBlob(res);
    try {
      const file = new File([blob], res.name, { type: 'application/pdf' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: res.name });
        finishReceipt();
        return;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return; // share sheet cancelled - stay on the receipt
    }
    // Sharing not available here: download the PDF instead.
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = res.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    setTimeout(finishReceipt, 800);
  }

  // Close the receipt. After a new sale's receipt, return to a fresh Sale page.
  function finishReceipt() {
    const wasNew = CURRENT_RECEIPT.isNew;
    closeReceipt();
    CURRENT_RECEIPT.isNew = false;
    if (wasNew) {
      showScreen('sale');
      const main = document.querySelector('main');
      if (main) main.scrollTop = 0;
      window.scrollTo(0, 0);
    }
  }

  function closeReceipt() {
    document.getElementById('receiptModal').classList.remove('open');
    const f = document.getElementById('receiptFrame');
    f.onload = null;
    f.srcdoc = '';
    f.style.height = '420px';
  }

  // ---------- Customers screen ----------
  function saveCustomerPage() {
    const phone = document.getElementById('cpPhone').value.trim();
    const name = document.getElementById('cpName').value.trim();
    const address = document.getElementById('cpAddress').value.trim();
    if (!phone) { showToast('Phone number is required.'); return; }
    if (!name) { showToast('Enter a customer name.'); return; }
    bizRun().withSuccessHandler(c => {
      if (c && c.Existing) {
        showToast('Phone already registered to ' + c.Name + '.');
      } else {
        showToast('Customer saved.');
        document.getElementById('cpPhone').value = '';
        document.getElementById('cpName').value = '';
        document.getElementById('cpAddress').value = '';
        loadCustomerList();
      }
    }).withFailureHandler(onError).addCustomer({ name, phone, address });
  }

  function openCustHistory(c) {
    document.getElementById('custHistoryTitle').textContent = c.Name + "'s history";
    document.getElementById('custHistoryCard').style.display = 'block';
    document.getElementById('custHistoryCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.getElementById('custHistoryList').innerHTML = '<div class="empty">Loading...</div>';
    bizRun().withSuccessHandler(renderCustHistory).withFailureHandler(onError).getCustomerHistory(c.CustomerID);
  }

  function renderCustHistory(sales) {
    const box = document.getElementById('custHistoryList');
    if (!sales || sales.length === 0) { box.innerHTML = '<div class="empty">No past sales.</div>'; return; }
    box.innerHTML = sales.map(s => `
      <div class="item-row tap" onclick="openReceipt('${s.SaleID}')">
        <div class="name">${s.ReceiptNo}<div class="muted">${new Date(s.Date).toLocaleDateString()}</div></div>
        <div>${currency(s.Total)}</div>
      </div>`).join('');
  }

  // ---------- Expenses screen ----------
  function submitExpense() {
    const amount = Number(document.getElementById('expAmount').value);
    if (!amount || amount <= 0) { showToast('Enter an amount.'); return; }
    const payload = {
      date: document.getElementById('expDate').value,
      category: document.getElementById('expCategory').value,
      description: document.getElementById('expDescription').value,
      amount
    };
    bizRun().withSuccessHandler(() => {
      showToast('Expense saved.');
      document.getElementById('expDescription').value = '';
      document.getElementById('expAmount').value = 0;
      loadExpenses();
    }).withFailureHandler(onError).addExpense(payload);
  }

  function loadExpenses() {
    bizRun().withSuccessHandler(renderExpenses).withFailureHandler(onError).getExpenses(null, null);
  }

  function renderExpenses(list) {
    const box = document.getElementById('expensesList');
    if (!list || list.length === 0) { box.innerHTML = '<div class="empty">No expenses recorded yet.</div>'; return; }
    box.innerHTML = list.slice(0, 30).map(e => `
      <div class="item-row">
        <div class="name">${escapeHtml(e.Description || e.Category)}<div class="muted">${escapeHtml(e.Category)} · ${new Date(e.Date).toLocaleDateString()}</div></div>
        <div>${currency(e.Amount)}</div>
      </div>`).join('');
  }

  // ---------- Reports screen (date range) ----------
  let REPORT_READY = false;

  function ymd(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function setRepRange(kind) {
    const now = new Date();
    let from = '', to = '';
    if (kind === 'today') { from = to = ymd(now); }
    else if (kind === 'week') { const d = new Date(now); d.setDate(d.getDate() - 6); from = ymd(d); to = ymd(now); }
    else if (kind === 'month') { from = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-01'; to = ymd(now); }
    document.getElementById('repFrom').value = from;
    document.getElementById('repTo').value = to;
    loadReport();
  }

  function loadReport() {
    const from = document.getElementById('repFrom').value;
    const to = document.getElementById('repTo').value;
    if (from && to && from > to) { showToast('"From" date is after "To" date.'); return; }
    document.getElementById('repSalesList').innerHTML = '<div class="empty">Loading...</div>';
    bizRun().withSuccessHandler(renderReport).withFailureHandler(onError).getReportSummary(from, to);
  }

  function renderReport(r) {
    document.getElementById('repSalesCount').textContent = r.salesCount;
    document.getElementById('repTotalSales').textContent = currency(r.totalSales);
    document.getElementById('repTotalExpenses').textContent = currency(r.totalExpenses);
    document.getElementById('repNet').textContent = currency(r.net);
    const box = document.getElementById('repSalesList');
    if (!r.sales || r.sales.length === 0) { box.innerHTML = '<div class="empty">No sales in this range.</div>'; return; }
    box.innerHTML = r.sales.map(s => `
      <div class="item-row tap" onclick="openReceipt('${s.SaleID}')">
        <div class="name">${s.ReceiptNo}<div class="muted">${escapeHtml(new Date(s.Date).toLocaleDateString())} · ${escapeHtml(s.CustomerName || 'Walk-in')}</div></div>
        <div>${currency(s.Total)}</div>
      </div>`).join('') +
      (r.truncated ? '<div class="empty">Showing the latest 200 of ' + r.salesCount + ' sales. Narrow the dates to see the rest.</div>' : '');
  }

  // ---------- Settings screen ----------
  function populateSettingsForm() {
    document.getElementById('setName').value = STATE.settings.BusinessName || '';
    document.getElementById('setAddress').value = STATE.settings.Address || '';
    document.getElementById('setPhone').value = STATE.settings.Phone || '';
    document.getElementById('setCurrency').value = STATE.settings.Currency || '';
    document.getElementById('setFooter').value = STATE.settings.ReceiptFooter || '';
  }

  function saveSettings() {
    const payload = {
      BusinessName: document.getElementById('setName').value,
      Address: document.getElementById('setAddress').value,
      Phone: document.getElementById('setPhone').value,
      Currency: document.getElementById('setCurrency').value,
      ReceiptFooter: document.getElementById('setFooter').value
    };
    bizRun().withSuccessHandler(s => {
      STATE.settings = s;
      document.getElementById('hdrBiz').textContent = s.BusinessName || 'Services';
      showToast('Settings saved.');
    }).withFailureHandler(onError).updateBusinessSettings(payload);
  }

  // ---------- Services management (Settings screen) ----------
  function loadServicesManagement() {
    bizRun().withSuccessHandler(renderServicesManagement).withFailureHandler(onError).getAllServices();
  }

  function renderServicesManagement(list) {
    const box = document.getElementById('servicesManageList');
    if (!list || list.length === 0) { box.innerHTML = '<div class="empty">No services yet.</div>'; return; }
    box.innerHTML = list.map(s => {
      const isActive = (s.Active === true || s.Active === 'TRUE' || s.Active === 'true');
      return `
        <div class="item-row" style="flex-wrap:wrap;">
          <div class="name" style="min-width:100%;margin-bottom:6px;">
            <b>${escapeHtml(s.ServiceID)}</b> ${escapeHtml(s.Name)}
          </div>
          <input type="text" style="flex:2;" id="svcName_${s.ServiceID}" value="${escapeHtml(s.Name)}">
          <input type="number" style="flex:1;" id="svcPrice_${s.ServiceID}" value="${s.Price}" min="0">
          <label style="display:flex;align-items:center;gap:4px;font-size:12px;margin:0;flex:0 0 auto;">
            <input type="checkbox" id="svcActive_${s.ServiceID}" style="width:auto;" ${isActive ? 'checked' : ''}> Active
          </label>
          <button class="btn-secondary btn-small" onclick="saveServiceEdit('${s.ServiceID}')">Save</button>
        </div>`;
    }).join('');
  }

  function saveServiceEdit(serviceId) {
    const name = document.getElementById('svcName_' + serviceId).value.trim();
    const price = Number(document.getElementById('svcPrice_' + serviceId).value) || 0;
    const active = document.getElementById('svcActive_' + serviceId).checked;
    bizRun().withSuccessHandler(() => {
      showToast('Service updated.');
      loadServicesManagement();
      bizRun().withSuccessHandler(onInitData).withFailureHandler(onError).getInitData();
    }).withFailureHandler(onError).updateService(serviceId, { name, price, active });
  }

  function createService() {
    const name = document.getElementById('newSvcName').value.trim();
    const price = Number(document.getElementById('newSvcPrice').value) || 0;
    if (!name) { showToast('Enter a service name.'); return; }
    bizRun().withSuccessHandler(() => {
      showToast('Service added.');
      document.getElementById('newSvcName').value = '';
      document.getElementById('newSvcPrice').value = 0;
      loadServicesManagement();
      bizRun().withSuccessHandler(onInitData).withFailureHandler(onError).getInitData();
    }).withFailureHandler(onError).addService({ name, price });
  }

  // ---------- Customers: full list with lifetime spend ----------
  let CUST_LIST = [];

  function loadCustomerList() {
    bizRun().withSuccessHandler(renderCustomerList).withFailureHandler(onError).getCustomersWithSpend();
  }

  let CUST_SHOWN = [];

  function renderCustomerList(list) {
    CUST_LIST = list || [];
    applyCustFilter();
  }

  // The search box filters the list below it as you type (by name or phone).
  function applyCustFilter() {
    const q = document.getElementById('custPageSearch').value.trim().toLowerCase();
    const digits = q.replace(/[^0-9]/g, '');
    CUST_SHOWN = !q ? CUST_LIST : CUST_LIST.filter(c =>
      String(c.Name || '').toLowerCase().includes(q) ||
      (digits.length >= 3 && String(c.Phone || '').replace(/[^0-9]/g, '').includes(digits)));
    document.getElementById('custCount').textContent =
      q ? CUST_SHOWN.length + ' of ' + CUST_LIST.length : CUST_LIST.length;
    const box = document.getElementById('custListBox');
    if (CUST_LIST.length === 0) { box.innerHTML = '<div class="empty">No customers yet.</div>'; return; }
    if (CUST_SHOWN.length === 0) { box.innerHTML = '<div class="empty">No customer matches.</div>'; return; }
    box.innerHTML = CUST_SHOWN.map((c, i) => `
      <div class="item-row tap" onclick="openCustHistory(CUST_SHOWN[${i}])">
        <div class="name"><b>${escapeHtml(c.Name)}</b>
          <div class="muted">${escapeHtml(c.Phone || '')} &middot; ${c.Visits} ${c.Visits === 1 ? 'visit' : 'visits'}</div></div>
        <div style="font-weight:600;">${currency(c.TotalSpent)}</div>
      </div>`).join('');
  }

  // ---------- Expense categories (Settings screen) ----------
  function loadCategoriesManagement() {
    bizRun().withSuccessHandler(renderCategoriesManagement).withFailureHandler(onError).getAllCategories('Expense');
  }

  function renderCategoriesManagement(list) {
    const box = document.getElementById('categoriesManageList');
    if (!list || list.length === 0) { box.innerHTML = '<div class="empty">No categories yet.</div>'; return; }
    box.innerHTML = list.map(c => {
      const isActive = (c.Active === true || c.Active === 'TRUE' || c.Active === 'true');
      return `
        <div class="item-row" style="flex-wrap:wrap;">
          <input type="text" style="flex:2;" id="catName_${c.CategoryID}" value="${escapeHtml(c.Name)}">
          <label style="display:flex;align-items:center;gap:4px;font-size:12px;margin:0;flex:0 0 auto;">
            <input type="checkbox" id="catActive_${c.CategoryID}" style="width:auto;" ${isActive ? 'checked' : ''}> Active
          </label>
          <button class="btn-secondary btn-small" onclick="saveCategoryEdit('${c.CategoryID}')">Save</button>
        </div>`;
    }).join('');
  }

  function refreshCategoryLists() {
    loadCategoriesManagement();
    bizRun().withSuccessHandler(onInitData).withFailureHandler(onError).getInitData();
  }

  function saveCategoryEdit(id) {
    const name = document.getElementById('catName_' + id).value.trim();
    const active = document.getElementById('catActive_' + id).checked;
    bizRun().withSuccessHandler(() => {
      showToast('Category updated.');
      refreshCategoryLists();
    }).withFailureHandler(onError).updateCategory(id, { name, active });
  }

  function createCategory() {
    const name = document.getElementById('newCatName').value.trim();
    if (!name) { showToast('Enter a category name.'); return; }
    bizRun().withSuccessHandler(() => {
      showToast('Category added.');
      document.getElementById('newCatName').value = '';
      refreshCategoryLists();
    }).withFailureHandler(onError).addCategory({ name, type: 'Expense' });
  }

  // ---------- Utils ----------
  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  }
