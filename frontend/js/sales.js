  // ---------------- BUSINESS CODE (multi-business) ----------------
  const URL_CODE = (new URLSearchParams(location.search).get('b') || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);   // from the ?b=CODE link
  const HOME_URL = '/';   // the home / chooser page
  let BIZ_CODE = '';
  try { BIZ_CODE = localStorage.getItem('bizCode') || ''; } catch (e) {}

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
          r.api(BIZ_CODE, 'sales', String(name), args);
        };
      }
    });
    return p;
  }

  function showLogin(msg) {
    document.getElementById('loginError').textContent = msg || '';
    document.getElementById('loginModal').classList.add('show');
  }

  function startApp() {
    document.getElementById('loginModal').classList.remove('show');
    loadProducts();
    loadCustomers();
    loadConfig();
    loadCategories();
    document.getElementById('rxDate').value = dkey(new Date());
  }

  // Checks the code with the server (for the Sales app), then starts the app
  function loginWith(code) {
    document.getElementById('loginError').textContent = 'Checking...';
    google.script.run
      .withSuccessHandler(() => {
        BIZ_CODE = code;
        try { localStorage.setItem('bizCode', code); } catch (e) {}
        document.getElementById('loginError').textContent = '';
        startApp();
      })
      .withFailureHandler(() => {
        BIZ_CODE = '';
        try { localStorage.removeItem('bizCode'); } catch (e) {}
        showLogin('Invalid or inactive business code');
      })
      .checkBusiness(code, 'sales');
  }

  function submitLogin() {
    const code = document.getElementById('bizCodeInput').value.trim();
    if (code) loginWith(code);
  }

  // "Switch business" goes back to the chooser page
  function switchBusiness() {
    try { localStorage.removeItem('bizCode'); } catch (e) {}
    window.top.location.href = HOME_URL;
  }

  // ---------------- STATE ----------------
  let PRODUCTS = [];
  let CUSTOMERS = [];
  let CONFIG = {};
  let CART = [];                   // [{productId,name,price,qty}]
  let SELECTED_CUSTOMER = null;    // {id,name}
  let CURRENT_SALE_ID = null;
  let CURRENT_RECEIPT_HTML = '';

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ---------------- INIT ----------------
  window.onload = function () {
    if (URL_CODE) loginWith(URL_CODE);      // opened from a business link
    else if (BIZ_CODE) startApp();          // phone remembers the code
    else showLogin('');                     // first visit: ask for the code
  };

  function loadProducts() {
    bizRun()
      .withSuccessHandler(list => {
        try {
          PRODUCTS = list || [];
          renderProductResults();
          renderProductList();
        } catch (e) {
          showError('Products loaded but failed to display: ' + e.message);
        }
      })
      .withFailureHandler(err => showError('Products failed to load: ' + (err && err.message ? err.message : err)))
      .getProductsList();
  }

  function loadCustomers() {
    bizRun()
      .withSuccessHandler(list => {
        try {
          CUSTOMERS = list || [];
          renderCustomerResults();
          renderCustomerList();
        } catch (e) {
          showError('Customers loaded but failed to display: ' + e.message);
        }
      })
      .withFailureHandler(err => showError('Customers failed to load: ' + (err && err.message ? err.message : err)))
      .getCustomersList();
  }

  function loadConfig() {
    bizRun()
      .withSuccessHandler(cfg => {
        try {
          CONFIG = cfg || {};
          document.getElementById('headerBiz').textContent = CONFIG.BusinessName || 'Sales Tracker';
        } catch (e) {
          showError('Settings loaded but failed to display: ' + e.message);
        }
      })
      .withFailureHandler(err => showError('Settings failed to load: ' + (err && err.message ? err.message : err)))
      .getConfig();
  }

  function onError(err) {
    showToast('Error: ' + ((err && err.message) || err));
  }

  function showError(msg) {
    const banner = document.getElementById('errorBanner');
    banner.textContent = msg;
    banner.style.display = 'block';
  }

  function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2200);
  }

  // ---------------- CUSTOMER PICKER (Sale tab) ----------------
  function selectCustomer(id, name) {
    SELECTED_CUSTOMER = { id: id, name: name };
    document.getElementById('selCustName').textContent = name;
    document.getElementById('selectedCustomer').style.display = 'flex';
    document.getElementById('customerPicker').style.display = 'none';
    document.getElementById('customerResults').classList.remove('show');
    document.getElementById('customerResults').innerHTML = '';
    document.getElementById('customerSearch').value = '';
    document.getElementById('customerSearch').blur();
  }

  function clearCustomer() {
    SELECTED_CUSTOMER = null;
    document.getElementById('selectedCustomer').style.display = 'none';
    document.getElementById('customerPicker').style.display = 'block';
  }

  function openNewCustomerModal() {
    const typed = document.getElementById('customerSearch').value.trim();
    const looksLikePhone = /^[+\d][\d\s-]{5,}$/.test(typed);
    document.getElementById('qcName').value = looksLikePhone ? '' : typed;
    document.getElementById('qcPhone').value = looksLikePhone ? typed : '';
    document.getElementById('newCustModal').classList.add('show');
  }

  function closeNewCustomerModal() {
    document.getElementById('newCustModal').classList.remove('show');
  }

  function quickAddCustomer() {
    const name = document.getElementById('qcName').value.trim();
    if (!name) { showToast('Enter customer name'); return; }
    const payload = {
      name: name,
      phone: document.getElementById('qcPhone').value.trim(),
      email: '',
      address: ''
    };
    bizRun().withSuccessHandler(res => {
      const record = { CustomerID: res.id, Name: res.name, Phone: res.phone,
                       Email: res.email, Address: res.address, TotalPurchases: res.totalPurchases };
      const idx = CUSTOMERS.findIndex(c => c.CustomerID === res.id);
      if (idx > -1) CUSTOMERS[idx] = record; else CUSTOMERS.push(record);
      renderCustomerList();
      closeNewCustomerModal();
      selectCustomer(res.id, res.name);
      showToast(res.existing ? 'Existing customer selected' : 'Customer added');
    }).withFailureHandler(onError).addCustomer(payload);
  }

  // ---------------- TAB NAV ----------------
  function switchTab(name, btn) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById('page-' + name).classList.add('active');
    document.querySelectorAll('nav.tabbar button').forEach(b => b.classList.remove('active'));
    const activeBtn = document.querySelector('nav.tabbar button[data-tab="' + name + '"]') || btn;
    if (activeBtn) activeBtn.classList.add('active');
    const titles = { sale: 'New Sale', products: 'Products & Stock', customers: 'Customers', expenses: 'Expenses', history: 'Sales History' };
    document.getElementById('headerPage').textContent = titles[name];
    document.querySelectorAll('.dropdown-list').forEach(d => d.classList.remove('show'));
    window.scrollTo(0, 0);
    if (name === 'history' && BIZ_CODE) loadHistory();
    if (name === 'expenses' && BIZ_CODE) loadExpenses();
  }

  // Search by name or phone. Results show inline only while something is typed.
  function renderCustomerResults() {
    const raw = (document.getElementById('customerSearch').value || '').trim().toLowerCase();
    const container = document.getElementById('customerResults');
    if (!raw) { container.innerHTML = ''; container.classList.remove('show'); return; }
    const digits = raw.replace(/\D/g, '');
    const all = Array.isArray(CUSTOMERS) ? CUSTOMERS : [];
    const matches = all.filter(c => {
      const name = String(c.Name || '').toLowerCase();
      const phone = String(c.Phone || '').replace(/\D/g, '');
      return name.includes(raw) || (digits.length >= 2 && phone.includes(digits));
    })
      .sort((a, b) => String(a.Name || '').localeCompare(String(b.Name || '')))
      .slice(0, 30);

    container.innerHTML = matches.map(c =>
      `<div class="list-item" data-id="${escapeHtml(c.CustomerID)}">
         <div><div class="name">${escapeHtml(c.Name)}</div>
         <div class="sub">${escapeHtml(c.Phone)}</div></div>
       </div>`
    ).join('') || '<div class="empty">No customer found — tap “+ Add New Customer”</div>';
    container.classList.add('show');
  }

  // 'click' (not 'mousedown') so the follow-up synthetic tap on phones can't
  // land on whatever appears under the finger once the dropdown closes.
  document.getElementById('customerResults').addEventListener('click', e => {
    const item = e.target.closest('.list-item');
    if (!item) return;
    const c = CUSTOMERS.find(x => String(x.CustomerID) === item.dataset.id);
    if (c) selectCustomer(c.CustomerID, c.Name);
  });

  // ---------------- PRODUCT PICKER (Sale tab) ----------------
  // Search by name (or category). Results show inline only while something is typed.
  function renderProductResults() {
    const q = (document.getElementById('productSearch').value || '').trim().toLowerCase();
    const container = document.getElementById('productResults');
    if (!q) { container.innerHTML = ''; container.classList.remove('show'); return; }
    const matches = PRODUCTS.filter(p =>
        String(p.Name || '').toLowerCase().includes(q) || String(p.Category || '').toLowerCase().includes(q))
      .sort((a, b) => String(a.Name || '').localeCompare(String(b.Name || '')))
      .slice(0, 30);
    container.innerHTML = matches.map(p => {
      const out = !(Number(p.Stock) > 0);
      return `<div class="list-item${out ? ' out' : ''}" data-id="${escapeHtml(p.ProductID)}">
         <div><div class="name">${escapeHtml(p.Name)}</div><div class="sub">${money(p.SellingPrice)}${(p.Tiers||[]).length > 1 ? ' (then ' + money(p.Tiers[1].price) + ')' : ''} • Stock: ${escapeHtml(p.Stock)}</div></div>
         ${out ? '<span class="out-tag">Out of stock</span>' : '<button class="btn-secondary" type="button">Add</button>'}
       </div>`;
    }).join('') || '<div class="empty">No product found</div>';
    container.classList.add('show');
  }

  // One handler for the row and the Add button, so a tap adds exactly one item
  document.getElementById('productResults').addEventListener('click', e => {
    const item = e.target.closest('.list-item');
    if (!item) return;
    addToCart(item.dataset.id);
  });

  function addToCart(productId) {
    const p = PRODUCTS.find(x => String(x.ProductID) === String(productId));
    if (!p) return;
    const stock = Number(p.Stock) || 0;
    if (stock <= 0) { showToast(p.Name + ' is out of stock'); return; }
    const existing = CART.find(c => String(c.productId) === String(productId));
    if (existing && existing.qty + 1 > stock) { showToast('Only ' + stock + ' of ' + p.Name + ' in stock'); return; }
    if (existing) { existing.qty += 1; }
    else { CART.push({ productId: p.ProductID, name: p.Name, price: Number(p.SellingPrice), qty: 1 }); }
    document.getElementById('productResults').classList.remove('show');
    document.getElementById('productResults').innerHTML = '';
    const input = document.getElementById('productSearch');
    input.value = '';
    input.blur();
    renderCart();
  }

  function changeQty(productId, delta) {
    const item = CART.find(c => String(c.productId) === String(productId));
    if (!item) return;
    if (delta > 0) {
      const p = PRODUCTS.find(x => String(x.ProductID) === String(productId));
      const stock = p ? (Number(p.Stock) || 0) : Infinity;
      if (item.qty + delta > stock) { showToast('Only ' + stock + ' in stock'); return; }
    }
    item.qty += delta;
    if (item.qty <= 0) CART = CART.filter(c => String(c.productId) !== String(productId));
    renderCart();
  }

  function removeFromCart(productId) {
    CART = CART.filter(c => String(c.productId) !== String(productId));
    renderCart();
  }

  function renderCart() {
    const container = document.getElementById('lineItems');
    if (!CART.length) {
      container.innerHTML = '<div class="empty">No items added yet</div>';
      document.getElementById('totalsBox').style.display = 'none';
      return;
    }
    container.innerHTML = CART.map(c =>
      `<div class="line-item" data-id="${escapeHtml(c.productId)}">
         <div>
           <div>${escapeHtml(c.name)}</div>
           ${splitText(c) ? `<div class="sub">${escapeHtml(splitText(c))}</div>` : ''}
           <div class="qty-stepper">
             <button type="button" data-act="minus">-</button>
             <span>${c.qty}</span>
             <button type="button" data-act="plus">+</button>
           </div>
         </div>
         <div style="text-align:right;">
           <div>${money(lineTotal(c))}</div>
           <button class="remove" type="button" data-act="remove">remove</button>
         </div>
       </div>`
    ).join('');
    document.getElementById('totalsBox').style.display = 'block';
    renderTotals();
  }

  document.getElementById('lineItems').addEventListener('click', e => {
    const btn = e.target.closest('button[data-act]');
    const row = e.target.closest('.line-item');
    if (!btn || !row) return;
    const id = row.dataset.id;
    if (btn.dataset.act === 'minus') changeQty(id, -1);
    else if (btn.dataset.act === 'plus') changeQty(id, 1);
    else if (btn.dataset.act === 'remove') removeFromCart(id);
  });

  function money(n) { return (CONFIG.Currency || '') + Number(n || 0).toFixed(2); }

  // A product can be on sale at more than one price (old stock vs newly bought stock).
  // p.Tiers = [{qty, price}] in the order they sell; the server uses the same rule.
  function tierBreakdown(p, qty) {
    const out = [];
    let left = qty;
    ((p && p.Tiers) || []).forEach(t => {
      if (left <= 0) return;
      const n = Math.min(left, t.qty);
      out.push({ n: n, price: Number(t.price) || 0 });
      left -= n;
    });
    if (left > 0) out.push({ n: left, price: p ? Number(p.SellingPrice) || 0 : 0 });
    return out;
  }
  function cartProduct(c) { return PRODUCTS.find(x => String(x.ProductID) === String(c.productId)); }
  function lineTotal(c) { return tierBreakdown(cartProduct(c), c.qty).reduce((s, b) => s + b.n * b.price, 0); }
  function splitText(c) {
    const b = tierBreakdown(cartProduct(c), c.qty);
    return b.length > 1 ? b.map(x => x.n + ' @ ' + money(x.price)).join(' + ') : '';
  }

  // Discount is entered as a percentage (0-100) of the subtotal
  function getTotals() {
    const subtotal = CART.reduce((sum, c) => sum + lineTotal(c), 0);
    let pct = Number(document.getElementById('discountInput').value) || 0;
    pct = Math.min(Math.max(pct, 0), 100);
    const discountAmt = Math.round(subtotal * pct) / 100;   // subtotal * pct / 100, 2 d.p.
    const total = Math.max(subtotal - discountAmt, 0);
    return { subtotal, pct, discountAmt, total };
  }

  function renderTotals() {
    const t = getTotals();
    document.getElementById('tSubtotal').textContent = money(t.subtotal);
    document.getElementById('tDiscount').textContent = (t.discountAmt ? '-' : '') + money(t.discountAmt);
    document.getElementById('tTotal').textContent = money(t.total);
  }

  // ---------------- COMPLETE SALE ----------------
  function completeSale() {
    if (!CART.length) { showToast('Add at least one item'); return; }
    const payload = {
      customerId: SELECTED_CUSTOMER ? SELECTED_CUSTOMER.id : '',
      customerName: SELECTED_CUSTOMER ? SELECTED_CUSTOMER.name : 'Walk-in',
      items: CART,
      discount: getTotals().discountAmt,          // amount, so the server/receipt stay unchanged
      discountPercent: getTotals().pct,
      paymentMethod: document.getElementById('paymentMethod').value
    };
    showToast('Saving sale...');
    bizRun().withSuccessHandler(sale => {
      CURRENT_SALE_ID = sale.saleId;
      resetSaleForm();
      showToast('Sale saved!');
      openReceipt(sale.saleId);
    }).withFailureHandler(onError).saveSale(payload);
  }

  function resetSaleForm() {
    CART = [];
    SELECTED_CUSTOMER = null;
    document.getElementById('discountInput').value = 0;
    document.getElementById('customerSearch').value = '';
    document.getElementById('productSearch').value = '';
    document.getElementById('productResults').classList.remove('show');
    clearCustomer();
    renderCart();
  }

  // ---------------- RECEIPT MODAL ----------------
  function openReceipt(saleId) {
    CURRENT_SALE_ID = saleId;
    CURRENT_RECEIPT_HTML = '';
    CURRENT_PDF = null;
    document.getElementById('receiptModal').classList.add('show');
    document.getElementById('receiptSpinner').style.display = 'block';
    document.getElementById('receiptFrame').style.display = 'none';
    // Build the PDF in the background so Share is instant when tapped
    CURRENT_PDF = requestPdf(saleId);
    CURRENT_PDF.catch(() => {});
    bizRun().withSuccessHandler(html => {
      CURRENT_RECEIPT_HTML = html;
      const frame = document.getElementById('receiptFrame');
      // Grow the frame to the whole receipt so nothing is cut off
      frame.onload = () => {
        try { frame.style.height = (frame.contentDocument.documentElement.scrollHeight + 8) + 'px'; } catch (e) {}
      };
      frame.srcdoc = html;
      document.getElementById('receiptSpinner').style.display = 'none';
      frame.style.display = 'block';
    }).withFailureHandler(onError).getReceiptHtml(saleId);
  }

  function closeReceiptModal() {
    document.getElementById('receiptModal').classList.remove('show');
    const f = document.getElementById('receiptFrame');
    f.onload = null;
    f.srcdoc = '';
    f.style.height = '60vh';
  }

  // After printing / sharing / saving a receipt: close it and go back to a fresh Sale page
  function finishReceipt() {
    closeReceiptModal();
    switchTab('sale');
  }

  // Prints the receipt only: the @media print rules above hide the rest of the screen.
  let AWAITING_PRINT = false;
  function printReceipt() {
    if (!CURRENT_RECEIPT_HTML) { showToast('Receipt still loading, try again'); return; }
    AWAITING_PRINT = true;
    window.print();
  }
  window.addEventListener('afterprint', () => {
    if (AWAITING_PRINT) { AWAITING_PRINT = false; finishReceipt(); }
  });

  // ---- Share as a PDF that contains only the receipt ----
  let CURRENT_PDF = null;
  function requestPdf(saleId) {
    return new Promise((resolve, reject) => {
      bizRun().withSuccessHandler(resolve).withFailureHandler(reject).getReceiptPdf(saleId);
    });
  }

  function pdfToBlob(res) {
    const bin = atob(res.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: 'application/pdf' });
  }

  async function shareReceipt() {
    if (!CURRENT_SALE_ID) return;
    showToast('Preparing receipt...');
    let res;
    try {
      res = await CURRENT_PDF;
    } catch (e) {
      try { res = await requestPdf(CURRENT_SALE_ID); } catch (err) { onError(err); return; }
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
      if (e && e.name === 'AbortError') return;   // share sheet cancelled - stay on the receipt
    }
    // Sharing not available here: download the PDF instead
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = res.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    setTimeout(finishReceipt, 800);
  }

  // Saves a PDF copy to this device (the old version saved it to Google Drive)
  function archiveReceipt() {
    showToast('Preparing PDF...');
    requestPdf(CURRENT_SALE_ID).then(res => {
      const url = URL.createObjectURL(pdfToBlob(res));
      const a = document.createElement('a');
      a.href = url; a.download = res.name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      showToast('Saved as ' + res.name);
      finishReceipt();
    }).catch(onError);
  }

  // ---------------- CATEGORIES (editable dropdown lists) ----------------
  let CATEGORIES = [];

  function catOn(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }

  function loadCategories(done) {
    bizRun().withSuccessHandler(list => {
      CATEGORIES = list || [];
      fillCatSelect('newProdCategory', 'Product');
      fillCatSelect('rxCategory', 'Expense');
      renderCatManager('Product');
      renderCatManager('Expense');
      if (done) done();
    }).withFailureHandler(err => showError('Categories failed to load: ' + (err && err.message ? err.message : err)))
      .getCategoriesList();
  }

  // Fills a category dropdown from the list; the last option lets you add a new one on the spot
  function fillCatSelect(selId, type, keep) {
    const sel = document.getElementById(selId);
    const cur = keep !== undefined ? keep : sel.value;
    const names = CATEGORIES.filter(c => c.Type === type && catOn(c.Active)).map(c => c.Name);
    if (cur && cur !== '__new__' && !names.includes(cur)) names.push(cur);   // e.g. an older product's category
    sel.innerHTML = '<option value="">Select category</option>' +
      names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('') +
      '<option value="__new__">+ Add new category…</option>';
    sel.value = (cur && cur !== '__new__') ? cur : '';
  }

  function onCatSelect(selId, type) {
    const isNew = document.getElementById(selId).value === '__new__';
    document.getElementById('inline_' + type).style.display = isNew ? 'flex' : 'none';
    if (isNew) document.getElementById('inlineName_' + type).focus();
  }

  function addInlineCat(selId, type) {
    const inp = document.getElementById('inlineName_' + type);
    const name = inp.value.trim();
    if (!name) { showToast('Type the new category name'); return; }
    bizRun().withSuccessHandler(res => {
      inp.value = '';
      document.getElementById('inline_' + type).style.display = 'none';
      loadCategories(() => fillCatSelect(selId, type, res.Name));
      showToast(res.existing ? 'That category already exists - selected' : 'Category added');
    }).withFailureHandler(onError).addCategory({ name, type });
  }

  // Manage lists (rename / switch off / add)
  function renderCatManager(type) {
    const box = document.getElementById('catList_' + type);
    const list = CATEGORIES.filter(c => c.Type === type);
    if (!list.length) { box.innerHTML = '<div class="empty">No categories yet</div>'; return; }
    box.innerHTML = list.map(c => `
      <div class="cat-row">
        <input type="text" id="catName_${c.CategoryID}" value="${escapeHtml(c.Name)}">
        <label class="cat-on"><input type="checkbox" id="catOn_${c.CategoryID}" ${c.Active ? 'checked' : ''}> Active</label>
        <button class="btn-secondary" type="button" onclick="saveCat('${c.CategoryID}')">Save</button>
      </div>`).join('');
  }

  function saveCat(id) {
    const name = document.getElementById('catName_' + id).value.trim();
    const active = document.getElementById('catOn_' + id).checked;
    if (!name) { showToast('Category name is required'); return; }
    bizRun().withSuccessHandler(() => {
      showToast('Category updated');
      loadCategories();
      loadProducts();       // product categories may have been renamed
      loadExpenses();       // so may expense categories
    }).withFailureHandler(onError).updateCategory(id, { name, active });
  }

  function addCatFromManager(type) {
    const inp = document.getElementById('newCat_' + type);
    const name = inp.value.trim();
    if (!name) { showToast('Type the new category name'); return; }
    bizRun().withSuccessHandler(res => {
      inp.value = '';
      showToast(res.existing ? 'That category already exists' : 'Category added');
      loadCategories();
    }).withFailureHandler(onError).addCategory({ name, type });
  }

  // ---------------- PRODUCTS TAB (buy / restock + stock) ----------------
  // Spelling check: as you type a name, products that look the same (or nearly) pop up
  // so you pick the exact existing name instead of creating a misspelt duplicate.
  function lev(a, b) {              // edit distance (counts a swapped pair of letters as one slip)
    const d = [];
    for (let i = 0; i <= a.length; i++) d[i] = [i];
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
    return d[a.length][b.length];
  }
  function squash(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
  function nameClose(q, name) {
    const a = squash(q), b = squash(name);
    if (!a || !b) return false;
    if (b.includes(a) || a.includes(b)) return true;
    const tol = a.length >= 7 ? 2 : (a.length >= 4 ? 1 : 0);
    if (!tol) return false;
    const words = String(name).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    return lev(a, b) <= tol || lev(a, b.slice(0, a.length)) <= tol || words.some(w => lev(a, w) <= tol);
  }

  function onProdNameInput() { updateProdHint(); renderProdSuggest(); }

  function hideProdSuggest() {
    const box = document.getElementById('prodSuggest');
    box.innerHTML = '';
    box.classList.remove('show');
  }

  function renderProdSuggest() {
    const box = document.getElementById('prodSuggest');
    const q = document.getElementById('newProdName').value.trim().toLowerCase().replace(/\s+/g, ' ');
    if (q.length < 2) { hideProdSuggest(); return; }
    const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (PRODUCTS.some(p => norm(p.Name) === q)) { hideProdSuggest(); return; }   // exact match: it is a restock
    const matches = PRODUCTS.filter(p => nameClose(q, p.Name))
      .sort((x, y) => lev(squash(q), squash(x.Name)) - lev(squash(q), squash(y.Name)))
      .slice(0, 6);
    if (!matches.length) { hideProdSuggest(); return; }
    box.innerHTML = '<div class="hint" style="padding:8px 12px 0;margin:0;">Already in your products - tap to use the exact name</div>' +
      matches.map(p =>
        `<div class="list-item" data-id="${escapeHtml(p.ProductID)}">
           <div><div class="name">${escapeHtml(p.Name)}</div>
           <div class="sub">${escapeHtml(p.Category || 'No category')} • Stock: ${escapeHtml(p.Stock)} • ${money(p.SellingPrice)}</div></div>
           <button class="btn-secondary" type="button">Use</button>
         </div>`).join('');
    box.classList.add('show');
  }

  document.getElementById('prodSuggest').addEventListener('click', e => {
    const item = e.target.closest('.list-item');
    if (!item) return;
    const p = PRODUCTS.find(x => String(x.ProductID) === item.dataset.id);
    if (!p) return;
    document.getElementById('newProdName').value = p.Name;
    document.getElementById('newProdUnit').value = p.Unit || 'pcs';
    fillCatSelect('newProdCategory', 'Product', p.Category || '');
    document.getElementById('inline_Product').style.display = 'none';
    hideProdSuggest();
    updateProdHint();
    document.getElementById('newProdCost').focus();
  });

  function updateProdHint() {
    const norm = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const name = norm(document.getElementById('newProdName').value);
    const el = document.getElementById('prodHint');
    if (!name) { el.style.display = 'none'; return; }
    const p = PRODUCTS.find(x => norm(x.Name) === name);
    el.style.display = 'block';
    el.textContent = p
      ? 'Existing product ' + p.ProductID + ': ' + p.Stock + ' in stock, selling at ' + money(p.SellingPrice) +
        '. This will be a restock. A higher selling price also raises the stock you still have; a lower one starts only after the current stock is sold.'
      : 'New product: an ID is created automatically.';
  }

  function submitNewProduct() {
    const name = document.getElementById('newProdName').value.trim();
    if (!name) { showToast('Enter product name'); return; }
    if (!(Number(document.getElementById('newProdStock').value) > 0)) { showToast('Enter the quantity bought'); return; }
    const cat = document.getElementById('newProdCategory').value;
    if (cat === '__new__') { showToast('Tap Add to save the new category, or pick one'); return; }
    const payload = {
      name,
      category: cat,
      unit: document.getElementById('newProdUnit').value.trim() || 'pcs',
      costPrice: document.getElementById('newProdCost').value,
      sellingPrice: document.getElementById('newProdPrice').value,
      stock: document.getElementById('newProdStock').value
    };
    bizRun().withSuccessHandler(res => {
      document.getElementById('newProdName').value = '';
      fillCatSelect('newProdCategory', 'Product', '');
      document.getElementById('newProdCost').value = '';
      document.getElementById('newProdPrice').value = '';
      document.getElementById('newProdStock').value = '';
      hideProdSuggest();
      updateProdHint();
      showToast(res.existing ? 'Restocked ' + res.name + ' (' + res.id + ')' : 'New product added (' + res.id + ')');
      loadProducts();      // refresh stock and prices
      loadExpenses();      // the purchase is now in the Expenses sheet
      loadCategories();    // a new category may have been created
    }).withFailureHandler(onError).addProduct(payload);
  }

  function renderProductList() {
    const q = (document.getElementById('productListSearch').value || '').toLowerCase();
    const container = document.getElementById('productList');
    const list = PRODUCTS.filter(p => (p.Name||'').toLowerCase().includes(q));
    container.innerHTML = list.map(p => {
      const stock = Number(p.Stock) || 0;
      const tiers = p.Tiers || [];
      const tierText = tiers.length > 1 ? tiers.map(t => t.qty + ' @ ' + money(t.price)).join(' → ') : '';
      return `<div class="list-item">
         <div>
           <div class="name">${escapeHtml(p.Name)} <span class="sub">${escapeHtml(p.ProductID)}</span></div>
           <div class="sub">${escapeHtml(p.Category||'')} • ${stock > 0 ? 'Stock: ' + stock + ' ' + escapeHtml(p.Unit||'') : '<span class="low">Out of stock</span>'}</div>
           ${tierText ? '<div class="sub">' + escapeHtml(tierText) + '</div>' : ''}
         </div>
         <div style="text-align:right;">
           <div>${money(p.SellingPrice)}</div>
           <div class="sub">Cost: ${money(p.CostPrice)}</div>
         </div>
       </div>`;
    }).join('') || '<div class="empty">No products yet</div>';
  }

  // ---------------- CUSTOMERS TAB ----------------
  function submitNewCustomer() {
    const name = document.getElementById('newCustName').value.trim();
    if (!name) { showToast('Enter customer name'); return; }
    const payload = {
      name,
      phone: document.getElementById('newCustPhone').value.trim(),
      email: document.getElementById('newCustEmail').value.trim(),
      address: document.getElementById('newCustAddress').value.trim()
    };
    bizRun().withSuccessHandler(res => {
      const existingIdx = CUSTOMERS.findIndex(c => c.CustomerID === res.id);
      const record = { CustomerID: res.id, Name: res.name, Phone: res.phone, Email: res.email, Address: res.address, TotalPurchases: res.totalPurchases };
      if (existingIdx > -1) CUSTOMERS[existingIdx] = record; else CUSTOMERS.push(record);
      renderCustomerList();
      document.getElementById('newCustName').value = '';
      document.getElementById('newCustPhone').value = '';
      document.getElementById('newCustEmail').value = '';
      document.getElementById('newCustAddress').value = '';
      showToast(res.existing ? 'Updated existing customer (' + res.id + ')' : 'New customer added (' + res.id + ')');
    }).withFailureHandler(onError).addCustomer(payload);
  }

  function renderCustomerList() {
    const q = (document.getElementById('customerListSearch').value || '').toLowerCase();
    const container = document.getElementById('customerList');
    const list = CUSTOMERS.filter(c => (c.Name||'').toLowerCase().includes(q));
    container.innerHTML = list.map(c =>
      `<div class="list-item">
         <div><div class="name">${escapeHtml(c.Name)}</div><div class="sub">${escapeHtml(c.Phone||'')}</div></div>
         <div class="sub">Spent: ${escapeHtml(CONFIG.Currency||'')}${Number(c.TotalPurchases||0).toFixed(2)}</div>
       </div>`
    ).join('') || '<div class="empty">No customers yet</div>';
  }

  // ---------------- EXPENSES TAB (running expenses + goods bought) ----------------
  let EXPENSES = [];      // goods bought / restocked (stock batches)
  let RUNNING = [];       // fuel, transport, domestic and other running costs
  let EXP_RANGE_READY = false;

  function loadExpenses() {
    document.getElementById('expBody').innerHTML = '<div class="spinner">Loading...</div>';
    let pending = 2;
    const done = () => {
      if (--pending > 0) return;
      if (!EXP_RANGE_READY) { EXP_RANGE_READY = true; setExpRange('month'); }
      else renderExpenses();
    };
    bizRun().withSuccessHandler(rows => { EXPENSES = rows || []; done(); })
      .withFailureHandler(err => { onError(err); done(); }).getExpensesList();
    bizRun().withSuccessHandler(rows => { RUNNING = rows || []; done(); })
      .withFailureHandler(err => { onError(err); done(); }).getRunningExpenses();
  }

  function submitRunningExpense() {
    const amount = Number(document.getElementById('rxAmount').value);
    if (!(amount > 0)) { showToast('Enter an amount'); return; }
    const cat = document.getElementById('rxCategory').value;
    if (!cat || cat === '__new__') { showToast('Choose a category'); return; }
    const payload = {
      date: document.getElementById('rxDate').value,
      category: cat,
      description: document.getElementById('rxDesc').value.trim(),
      amount
    };
    bizRun().withSuccessHandler(() => {
      document.getElementById('rxDesc').value = '';
      document.getElementById('rxAmount').value = '';
      showToast('Expense saved');
      loadExpenses();
    }).withFailureHandler(onError).addRunningExpense(payload);
  }

  function setExpRange(kind) {
    const now = new Date();
    let from = '', to = '';
    if (kind === 'today') { from = to = dkey(now); }
    else if (kind === 'week') { const d = new Date(now); d.setDate(d.getDate() - 6); from = dkey(d); to = dkey(now); }
    else if (kind === 'month') { from = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-01'; to = dkey(now); }
    document.getElementById('expFrom').value = from;
    document.getElementById('expTo').value = to;
    renderExpenses();
  }

  function renderExpenses() {
    const body = document.getElementById('expBody');
    const runBox = document.getElementById('runList');
    const goodsBox = document.getElementById('expList');
    const from = document.getElementById('expFrom').value;
    const to = document.getElementById('expTo').value;
    if (from && to && from > to) {
      body.innerHTML = '<div class="empty">“From” date is after “To” date</div>';
      runBox.innerHTML = ''; goodsBox.innerHTML = '';
      return;
    }
    const inRange = r => { const k = dkey(r.date); return k && (!from || k >= from) && (!to || k <= to); };
    const goods = EXPENSES.filter(inRange);
    const running = RUNNING.filter(inRange);

    const bought = goods.filter(r => r.type !== 'Opening');      // opening stock was bought before tracking
    const goodsTotal = bought.reduce((s, r) => s + (Number(r.total) || 0), 0);
    const runTotal = running.reduce((s, r) => s + (Number(r.amount) || 0), 0);

    body.innerHTML =
      `<div class="tiles">
         <div class="tile"><div class="t-label">Goods bought</div><div class="t-value">${money(goodsTotal)}</div></div>
         <div class="tile"><div class="t-label">Running costs</div><div class="t-value">${money(runTotal)}</div></div>
         <div class="tile" style="grid-column:1 / -1;"><div class="t-label">Total expenses</div><div class="t-value">${money(goodsTotal + runTotal)}</div></div>
       </div>`;

    runBox.innerHTML = running.length
      ? running.slice(0, 100).map(r =>
          `<div class="list-item">
             <div>
               <div class="name">${escapeHtml(r.description || r.category)}</div>
               <div class="sub">${escapeHtml(new Date(r.date).toLocaleDateString())} • ${escapeHtml(r.category)}</div>
             </div>
             <div>${money(r.amount)}</div>
           </div>`).join('') +
        (running.length > 100 ? '<div class="empty">Showing the latest 100 of ' + running.length + '</div>' : '')
      : '<div class="empty">No running expenses in this range</div>';

    goodsBox.innerHTML = goods.length
      ? goods.slice(0, 100).map(r =>
          `<div class="list-item">
             <div>
               <div class="name">${escapeHtml(r.name)}</div>
               <div class="sub">${escapeHtml(new Date(r.date).toLocaleDateString())} • ${r.type === 'Opening' ? 'Opening stock' : escapeHtml(r.type)} • ${r.qty} × ${money(r.unitCost)}</div>
               <div class="sub">Sells at ${money(r.sellingPrice)} • ${r.remaining > 0 ? r.remaining + ' left' : 'sold out'}</div>
             </div>
             <div>${r.type === 'Opening' ? '—' : money(r.total)}</div>
           </div>`).join('') +
        (goods.length > 100 ? '<div class="empty">Showing the latest 100 of ' + goods.length + ' purchases</div>' : '')
      : '<div class="empty">No purchases in this range</div>';
  }

  // ---------------- HISTORY TAB ----------------
  let HISTORY = [];
  let RANGE_READY = false;

  function dkey(v) {
    const d = new Date(v);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function setRange(kind) {
    const now = new Date();
    let from = '', to = '';
    if (kind === 'today') { from = to = dkey(now); }
    else if (kind === 'week') { const d = new Date(now); d.setDate(d.getDate() - 6); from = dkey(d); to = dkey(now); }
    else if (kind === 'month') { from = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-01'; to = dkey(now); }
    document.getElementById('repFrom').value = from;
    document.getElementById('repTo').value = to;
    renderReport();
  }

  function rowsInRange() {
    const from = document.getElementById('repFrom').value;
    const to = document.getElementById('repTo').value;
    return HISTORY.filter(r => {
      const k = dkey(r.date);
      return k && (!from || k >= from) && (!to || k <= to);
    }).sort((a, b) => new Date(b.date) - new Date(a.date));
  }

  function renderReport() {
    const body = document.getElementById('reportBody');
    const list = document.getElementById('historyList');
    const from = document.getElementById('repFrom').value;
    const to = document.getElementById('repTo').value;
    if (from && to && from > to) {
      body.innerHTML = '<div class="empty">“From” date is after “To” date</div>';
      list.innerHTML = '';
      return;
    }
    const rows = rowsInRange();

    if (!rows.length) {
      body.innerHTML = '<div class="empty">No sales in this range</div>';
      list.innerHTML = '<div class="empty">No sales in this range</div>';
      return;
    }

    const total = rows.reduce((s, r) => s + (Number(r.total) || 0), 0);

    body.innerHTML =
      `<div class="tiles">
         <div class="tile"><div class="t-label">No. of Sales</div><div class="t-value">${rows.length}</div></div>
         <div class="tile"><div class="t-label">Total Sales</div><div class="t-value">${money(total)}</div></div>
       </div>`;

    list.innerHTML = rows.slice(0, 100).map(r =>
      `<div class="list-item" data-sale="${escapeHtml(r.saleId)}" style="cursor:pointer;">
         <div><div class="name">${escapeHtml(r.customerName)}</div><div class="sub">${escapeHtml(new Date(r.date).toLocaleString())} • ${escapeHtml(r.paymentMethod)}</div></div>
         <div>${money(r.total)}</div>
       </div>`
    ).join('') + (rows.length > 100 ? '<div class="empty">Showing the latest 100 of ' + rows.length + ' sales</div>' : '');
  }

  function loadHistory() {
    document.getElementById('historyList').innerHTML = '<div class="spinner">Loading...</div>';
    document.getElementById('reportBody').innerHTML = '<div class="spinner">Loading...</div>';
    bizRun().withSuccessHandler(rows => {
      HISTORY = rows || [];
      if (!RANGE_READY) { RANGE_READY = true; setRange('today'); }
      else renderReport();
    }).withFailureHandler(onError).getSalesHistory(5000);
  }

  document.getElementById('historyList').addEventListener('click', e => {
    const row = e.target.closest('.list-item[data-sale]');
    if (row) openReceipt(row.dataset.sale);
  });
