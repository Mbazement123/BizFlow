// Lets the existing pages keep calling google.script.run.withSuccessHandler(...).withFailureHandler(...).fn(...)
// while the work is now done by the Express backend over HTTPS.
(function () {
  var cfg = window.APP_CONFIG || {};
  var API = String(cfg.API_BASE || '').replace(/\/+$/, '');

  function post(path, body) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 70000);   // allows for a sleeping free server waking up
    return fetch(API + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    }).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: 'Server error (' + r.status + ')' }; });
    }).then(function (j) {
      if (!j.ok) throw new Error(j.error || 'Request failed');
      return j.result;
    }).catch(function (e) {
      if (e && e.name === 'AbortError') throw new Error('The server took too long to answer. Please try again.');
      if (e instanceof TypeError) throw new Error('Cannot reach the server. Check your internet connection and try again.');
      throw e;
    }).finally(function () { clearTimeout(timer); });
  }

  function runner(ok, fail) {
    return new Proxy({}, {
      get: function (_, name) {
        if (name === 'withSuccessHandler') return function (f) { return runner(f, fail); };
        if (name === 'withFailureHandler') return function (f) { return runner(ok, f); };
        if (name === 'withUserObject') return function () { return runner(ok, fail); };
        return function () {
          var a = Array.prototype.slice.call(arguments), p;
          if (name === 'api') p = post('/api/call', { code: a[0], app: a[1], fn: a[2], args: a[3] });
          else if (name === 'checkBusiness') p = post('/api/check', { code: a[0], app: a[1] });
          else p = Promise.reject(new Error('Unknown action: ' + String(name)));
          p.then(function (r) { if (ok) ok(r); }, function (e) { if (fail) fail(e); else console.error(e); });
        };
      }
    });
  }

  window.google = { script: { run: runner(null, null) } };
  window.apiPost = post;                       // used by the home page

  // A free Render server sleeps when idle: wake it as soon as any page opens.
  try { fetch(API + '/health', { mode: 'cors' }).catch(function () {}); } catch (e) {}
})();
