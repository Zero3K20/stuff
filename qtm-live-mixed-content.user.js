// ==UserScript==
// @name         QTM Live — Allow Mixed Content
// @namespace    https://th-live.online
// @version      0.5
// @description  Allows live streams served over plain http:// to play on
//               QTM-platform pages (which are served over https://).
//               Because the stream servers do not support HTTPS, URL-upgrading
//               cannot be used.  Every http:// XMLHttpRequest and fetch() call
//               made by the player (hls.js loads .m3u8 manifests and .ts
//               segments this way) is transparently routed through
//               GM_xmlhttpRequest, which runs in the extension context and is
//               not subject to the browser's mixed-content policy.
//
//               v0.3: On Chromium-based browsers (Chrome, Edge, Brave) running
//               Tampermonkey, the userscript sandbox runs in an isolated V8
//               world that is separate from the page's own JavaScript context.
//               Assigning a ProxiedXHR class directly to unsafeWindow.
//               XMLHttpRequest does not work because Chrome prevents
//               cross-world constructor invocation.
//
//               Fix: the XHR/fetch interception shim is serialised as a string
//               and injected into the page world via an inline <script> element
//               at document-start (before any page code runs).  Requests are
//               forwarded to the userscript (which has GM_xmlhttpRequest access)
//               via window.postMessage; responses are returned the same way.
//               ArrayBuffers are transferred (not cloned) to avoid a redundant
//               copy when loading .ts video segments.
//
//               v0.5: hls.js registers its response handler as
//               xhr.onreadystatechange = fn (property assignment, not
//               addEventListener), so PXhr._fire('readystatechange') silently
//               skipped it — the clearTimeout() call inside hls.js's handler
//               never ran, causing every request to hit the watchdog timer.
//               Fix: call xhr.onreadystatechange() explicitly alongside _fire().
// @match        https://th-live.online/*
// @match        https://qqlive.online/*
// @match        https://www.qqlive.online/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      *
// ==/UserScript==

// To add more QTM-clone domains, copy one of the @match lines above and
// change the hostname.  All sites on this platform share the same player
// stack (hls.js / video.js) and will be fixed by the same interceptions.

(function () {
  'use strict';

  // unsafeWindow IS the real page Window DOM node.  With @grant directives
  // Tampermonkey runs in an isolated sandbox; we use unsafeWindow to share
  // the postMessage channel with the injected page-world shim below.
  var w = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

  // ── 1. Page-world interception shim ───────────────────────────────────────
  //
  // The function below is serialised and injected as an inline <script> so it
  // runs in the page's own V8 context (not the Tampermonkey sandbox).  From
  // there it can replace window.XMLHttpRequest / window.fetch and the
  // replacements are visible to all page scripts (hls.js, video.js …).
  //
  // Message protocol (both directions use window.postMessage / addEventListener):
  //   page  → userscript : { __qtm: 'req', reqType: 'xhr'|'fetch',
  //                          id, method, url, headers, body,
  //                          responseType, timeout }
  //   userscript → page  : { __qtm: 'res', reqType: 'xhr'|'fetch',
  //                          id, status, statusText, responseURL,
  //                          responseHeaders, response [, error, url] }

  // IMPORTANT: This function is self-contained — it must not reference any
  // variable from the outer userscript scope because it is serialised with
  // .toString() and injected as a plain <script> string into the page world.
  // All dependencies (native XHR, native fetch, helpers) are captured inside
  // the function itself at injection time.
  var pageShimFn = function () {
    var _NXhr    = window.XMLHttpRequest;   // native XHR (captured before shim)
    var _nFetch  = window.fetch;            // native fetch (captured before shim)
    var _pending  = {};                     // id → PXhr awaiting GM response
    var _fPending = {};                     // id → {resolve,reject} for fetch
    var _seq      = 0;                      // monotonic request counter

    function isHTTP(url) {
      return typeof url === 'string' && url.startsWith('http://');
    }

    function parseHeaders(raw) {
      var h = {};
      (raw || '').split(/\r?\n/).forEach(function (line) {
        var c = line.indexOf(':');
        if (c > 0) h[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
      });
      return h;
    }

    // ── XHR shim ──────────────────────────────────────────────────────────────
    function PXhr() {
      this._proxy  = false;
      this._id     = 0;
      this._method = 'GET';
      this._url    = '';
      this._rh     = {};    // request headers
      this._ls     = {};    // addEventListener listeners
      this._nat    = null;  // native XHR for non-http requests
      this._rt     = '';    // responseType
      this._rspH   = {};    // parsed response headers

      this.readyState      = 0;
      this.status          = 0;
      this.statusText      = '';
      this.response        = null;
      this.responseText    = '';
      this.responseXML     = null;
      this.responseURL     = '';
      this.timeout         = 0;
      this.withCredentials = false;

      this.onreadystatechange = null;
      this.onload      = null;
      this.onerror     = null;
      this.ontimeout   = null;
      this.onprogress  = null;
      this.onloadstart = null;
      this.onloadend   = null;
      this.onabort     = null;

      this.upload = {
        onprogress:          null,
        addEventListener:    function () {},
        removeEventListener: function () {},
        dispatchEvent:       function () {}
      };
    }

    PXhr.UNSENT           = 0;
    PXhr.OPENED           = 1;
    PXhr.HEADERS_RECEIVED = 2;
    PXhr.LOADING          = 3;
    PXhr.DONE             = 4;

    PXhr.prototype.UNSENT           = 0;
    PXhr.prototype.OPENED           = 1;
    PXhr.prototype.HEADERS_RECEIVED = 2;
    PXhr.prototype.LOADING          = 3;
    PXhr.prototype.DONE             = 4;

    Object.defineProperty(PXhr.prototype, 'responseType', {
      get: function () { return this._rt; },
      set: function (v) {
        this._rt = v || '';
        if (this._nat) { try { this._nat.responseType = v; } catch (e) {} }
      },
      configurable: true
    });

    PXhr.prototype.open = function (method, url, async, user, pass) {
      this._method = method || 'GET';
      this._url    = url;
      if (isHTTP(url)) {
        this._proxy = true;
        this._nat   = null;
        this.readyState = 1;
        var evRSo = { type: 'readystatechange', target: this };
        this._fire('readystatechange', evRSo);
        if (this.onreadystatechange) this.onreadystatechange(evRSo);
      } else {
        this._proxy = false;
        this._nat   = new _NXhr();
        if (this._rt) { try { this._nat.responseType = this._rt; } catch (e) {} }
        this._nat.open(method, url, async === undefined ? true : !!async, user, pass);
      }
    };

    PXhr.prototype.setRequestHeader = function (name, value) {
      if (this._proxy)       { this._rh[name] = value; }
      else if (this._nat)    { this._nat.setRequestHeader(name, value); }
    };

    PXhr.prototype.send = function (body) {
      if (!this._proxy) { this._sendNative(body); return; }
      this._id = ++_seq;
      _pending[this._id] = this;
      var ev = { type: 'loadstart', target: this };
      this._fire('loadstart', ev);
      if (this.onloadstart) this.onloadstart(ev);
      window.postMessage({
        __qtm: 'req', reqType: 'xhr',
        id: this._id, method: this._method, url: this._url,
        headers: this._rh, body: body || null,
        responseType: this._rt || 'text', timeout: this.timeout || 0
      }, '*');
    };

    PXhr.prototype._sendNative = function (body) {
      var self = this;
      var n    = this._nat;
      try { if (self.timeout)         n.timeout         = self.timeout;        } catch (e) {}
      try { if (self.withCredentials) n.withCredentials = self.withCredentials; } catch (e) {}
      ['onreadystatechange', 'onload', 'onerror', 'ontimeout',
       'onprogress', 'onloadstart', 'onloadend', 'onabort'].forEach(function (k) {
        if (self[k]) n[k] = self[k];
      });
      n.addEventListener('readystatechange', function () {
        self.readyState = n.readyState;
        if (n.readyState >= 2) { self.status = n.status; self.statusText = n.statusText; }
        if (n.readyState === 4) {
          try { self.response     = n.response;     } catch (e) {}
          try { self.responseText = n.responseText; } catch (e) {}
          try { self.responseURL  = n.responseURL;  } catch (e) {}
        }
      });
      Object.keys(self._ls).forEach(function (type) {
        self._ls[type].forEach(function (fn) { n.addEventListener(type, fn); });
      });
      n.send(body);
    };

    PXhr.prototype.abort = function () {
      if (this._nat) {
        this._nat.abort();
      } else if (_pending[this._id]) {
        delete _pending[this._id];
      }
      this.readyState = 0;
      var ev = { type: 'abort', target: this };
      this._fire('abort', ev);
      if (this.onabort) this.onabort(ev);
    };

    PXhr.prototype.getResponseHeader = function (name) {
      if (this._proxy) return this._rspH[name.toLowerCase()] || null;
      return this._nat ? this._nat.getResponseHeader(name) : null;
    };

    PXhr.prototype.getAllResponseHeaders = function () {
      if (this._proxy) {
        var lines = Object.keys(this._rspH).map(function (k) {
          return k + ': ' + this._rspH[k];
        }, this);
        return lines.length ? lines.join('\r\n') + '\r\n' : '';
      }
      return this._nat ? this._nat.getAllResponseHeaders() : '';
    };

    PXhr.prototype.addEventListener = function (type, fn, opts) {
      if (!this._ls[type]) this._ls[type] = [];
      if (this._ls[type].indexOf(fn) === -1) this._ls[type].push(fn);
      if (this._nat) this._nat.addEventListener(type, fn, opts);
    };

    PXhr.prototype.removeEventListener = function (type, fn) {
      if (this._ls[type]) {
        var i = this._ls[type].indexOf(fn);
        if (i !== -1) this._ls[type].splice(i, 1);
      }
      if (this._nat) this._nat.removeEventListener(type, fn);
    };

    PXhr.prototype._fire = function (type, evt) {
      var fns = this._ls[type];
      if (!fns || !fns.length) return;
      evt.target = evt.target || this;
      evt.type   = type;
      for (var i = 0; i < fns.length; i++) { try { fns[i](evt); } catch (e) {} }
    };

    window.XMLHttpRequest = PXhr;

    // ── fetch() shim ──────────────────────────────────────────────────────────
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input
              : (input && input.url ? input.url : '');
      if (!isHTTP(url)) return _nFetch.apply(window, arguments);
      var method     = (init && init.method)  || (input && input.method)  || 'GET';
      var reqHeaders = (init && init.headers) || (input && input.headers) || {};
      var body       = (init && init.body)    || null;
      var hObj = {};
      if (typeof reqHeaders.forEach === 'function') {
        reqHeaders.forEach(function (v, k) { hObj[k] = v; });
      } else {
        hObj = reqHeaders;
      }
      return new Promise(function (resolve, reject) {
        var id = ++_seq;
        _fPending[id] = { resolve: resolve, reject: reject };
        window.postMessage({
          __qtm: 'req', reqType: 'fetch',
          id: id, method: method, url: url,
          headers: hObj, body: body
        }, '*');
      });
    };

    // ── Response listener (receives GM_xmlhttpRequest results from userscript)
    window.addEventListener('message', function (e) {
      var d = e.data;
      if (!d || !d.__qtm) return;

      // Progress event — keep hls.js's internal timeout watchdog alive.
      // hls.js clears/resets its JS timeout on every XHR progress event; without
      // these the watchdog fires before long .ts segments finish downloading.
      if (d.__qtm === 'prg') {
        var xhr = _pending[d.id];
        if (xhr) {
          var evPr = { type: 'progress', target: xhr,
                       loaded: d.loaded || 0, total: d.total || 0,
                       lengthComputable: !!(d.total) };
          xhr._fire('progress', evPr);
          if (xhr.onprogress) xhr.onprogress(evPr);
        }
        return;
      }

      if (d.__qtm !== 'res') return;

      if (d.reqType === 'xhr') {
        var xhr = _pending[d.id];
        if (!xhr) return;
        delete _pending[d.id];
        xhr._rspH       = parseHeaders(d.responseHeaders || '');
        xhr.status      = d.status     || 0;
        xhr.statusText  = d.statusText || '';
        xhr.responseURL = d.responseURL || xhr._url;
        if (d.error) {
          xhr.readyState = 4;
          var evRSe = { type: 'readystatechange', target: xhr };
          xhr._fire('readystatechange', evRSe);
          if (xhr.onreadystatechange) xhr.onreadystatechange(evRSe);
          var ee = { type: 'error',   target: xhr };
          xhr._fire('error',   ee); if (xhr.onerror)   xhr.onerror(ee);
          var el = { type: 'loadend', target: xhr };
          xhr._fire('loadend', el); if (xhr.onloadend) xhr.onloadend(el);
          return;
        }
        xhr.response     = d.response;
        xhr.responseText = typeof d.response === 'string' ? d.response : '';
        xhr.readyState   = 4;
        var evRS = { type: 'readystatechange', target: xhr };
        xhr._fire('readystatechange', evRS);
        if (xhr.onreadystatechange) xhr.onreadystatechange(evRS);
        var ev1 = { type: 'load',    target: xhr };
        xhr._fire('load',    ev1); if (xhr.onload)    xhr.onload(ev1);
        var ev2 = { type: 'loadend', target: xhr };
        xhr._fire('loadend', ev2); if (xhr.onloadend) xhr.onloadend(ev2);

      } else if (d.reqType === 'fetch') {
        var p = _fPending[d.id];
        if (!p) return;
        delete _fPending[d.id];
        if (d.error) {
          p.reject(new TypeError('QTM proxy: network error loading ' + d.url));
          return;
        }
        try {
          p.resolve(new Response(d.response, {
            status:     d.status,
            statusText: d.statusText || '',
            headers:    parseHeaders(d.responseHeaders || '')
          }));
        } catch (ex) { p.reject(ex); }
      }
    });
  };

  // Serialise the shim function and inject it as an inline <script> element.
  // Running inside a <script> tag executes in the page's own V8 world, so
  // window.XMLHttpRequest = PXhr is visible to all page scripts.
  var scriptEl = document.createElement('script');
  scriptEl.textContent = '(' + pageShimFn.toString() + ')()';
  (document.head || document.documentElement).appendChild(scriptEl);
  try { scriptEl.remove(); } catch (e) {}

  // ── 2. Bridge: receive page requests, call GM_xmlhttpRequest, reply ────────
  //
  // The page shim posts { __qtm:'req', ... } messages on window.
  // Because w = unsafeWindow shares the same DOM event bus as the page, our
  // listener here fires when the page shim calls window.postMessage().
  // We then call GM_xmlhttpRequest (extension context, no mixed-content block)
  // and postMessage the result back so the shim can resolve the XHR / fetch.
  //
  // ArrayBuffers are transferred (postMessage transferList) rather than cloned
  // to avoid a redundant copy for every .ts video segment.

  w.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.__qtm !== 'req') return;

    var id      = d.id;
    var reqType = d.reqType;
    var gmType  = d.responseType === 'arraybuffer' ? 'arraybuffer'
                : d.responseType === 'blob'        ? 'blob'
                :                                    'text';

    GM_xmlhttpRequest({
      method:       d.method || 'GET',
      url:          d.url,
      headers:      d.headers   || {},
      data:         d.body      || null,
      responseType: gmType,
      timeout:      d.timeout   || undefined,
      anonymous:    true,

      onload: function (res) {
        var response = res.response;
        var transfer = (response instanceof ArrayBuffer) ? [response] : [];
        w.postMessage({
          __qtm:           'res',
          reqType:         reqType,
          id:              id,
          status:          res.status,
          statusText:      res.statusText      || '',
          responseURL:     res.finalUrl        || d.url,
          responseHeaders: res.responseHeaders || '',
          response:        response
        }, '*', transfer);
      },

      onprogress: function (res) {
        w.postMessage({
          __qtm:  'prg',
          id:     id,
          loaded: res.loaded || 0,
          total:  res.total  || 0
        }, '*');
      },

      onerror: function () {
        w.postMessage({
          __qtm: 'res', reqType: reqType, id: id, error: true, url: d.url
        }, '*');
      },

      ontimeout: function () {
        w.postMessage({
          __qtm: 'res', reqType: reqType, id: id, error: true, url: d.url
        }, '*');
      }
    });
  });

})();
