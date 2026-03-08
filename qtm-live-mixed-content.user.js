// ==UserScript==
// @name         QTM Live — Allow Mixed Content
// @namespace    https://th-live.online
// @version      0.2
// @description  Allows live streams served over plain http:// to play on
//               QTM-platform pages (which are served over https://).
//               Because the stream servers do not support HTTPS, URL-upgrading
//               cannot be used.  Instead, every http:// XMLHttpRequest and
//               fetch() call made by the player (hls.js loads .m3u8 manifests
//               and .ts segments this way) is transparently routed through
//               GM_xmlhttpRequest, which runs in the extension context and is
//               not subject to the browser's mixed-content policy.
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

  // unsafeWindow is the real page Window object.  With @grant directives
  // active the userscript runs in an isolated sandbox, so we must write to
  // unsafeWindow (not `window`) to replace XMLHttpRequest / fetch for the
  // page's own scripts.
  var w = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

  // Only intercept plain http:// URLs — everything else passes through.
  function isHTTP(url) {
    return typeof url === 'string' && url.startsWith('http://');
  }

  // Parse a raw HTTP response-headers string into a plain object.
  function parseHeaders(raw) {
    var h = {};
    (raw || '').split(/\r?\n/).forEach(function (line) {
      var colon = line.indexOf(':');
      if (colon > 0) {
        h[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
    });
    return h;
  }

  // ── 1. XMLHttpRequest proxy ────────────────────────────────────────────────
  //
  // hls.js (and video.js's HLS plugin) load .m3u8 manifests and every .ts
  // segment via XMLHttpRequest.  The browser blocks these as active mixed
  // content when the page is HTTPS.  We replace window.XMLHttpRequest with a
  // shim that:
  //   • for http:// URLs — uses GM_xmlhttpRequest (extension context, no
  //     mixed-content restriction) and fires the same events / populates the
  //     same properties that hls.js expects.
  //   • for all other URLs — delegates 100 % to a real native XHR so that
  //     ordinary API calls are completely unaffected.

  var NativeXHR = w.XMLHttpRequest;

  function ProxiedXHR() {
    // Proxy-mode state
    this._isProxy    = false;
    this._url        = '';
    this._method     = 'GET';
    this._reqHeaders = {};
    this._gmReq      = null;
    this._listeners  = {};

    // Public XHR IDL attributes (proxy mode — native mode syncs from _native)
    this.readyState       = 0;
    this.status           = 0;
    this.statusText       = '';
    this.response         = null;
    this.responseText     = '';
    this.responseXML      = null;
    this.responseURL      = '';
    this._responseType    = '';
    this._responseHeaders = {};
    this.timeout          = 0;
    this.withCredentials  = false;

    // Event handler properties
    this.onreadystatechange = null;
    this.onload             = null;
    this.onerror            = null;
    this.ontimeout          = null;
    this.onprogress         = null;
    this.onloadstart        = null;
    this.onloadend          = null;
    this.onabort            = null;

    // upload stub — hls.js checks that xhr.upload exists
    this.upload = {
      onprogress:          null,
      addEventListener:    function () {},
      removeEventListener: function () {},
      dispatchEvent:       function () {}
    };

    // Delegate instance for non-http:// requests
    this._native = null;
  }

  // readyState constants on constructor
  ProxiedXHR.UNSENT           = 0;
  ProxiedXHR.OPENED           = 1;
  ProxiedXHR.HEADERS_RECEIVED = 2;
  ProxiedXHR.LOADING          = 3;
  ProxiedXHR.DONE             = 4;

  // readyState constants on prototype (so `xhr.DONE` works too)
  ProxiedXHR.prototype.UNSENT           = 0;
  ProxiedXHR.prototype.OPENED           = 1;
  ProxiedXHR.prototype.HEADERS_RECEIVED = 2;
  ProxiedXHR.prototype.LOADING          = 3;
  ProxiedXHR.prototype.DONE             = 4;

  // responseType must be a get/set property so we can forward it to _native
  Object.defineProperty(ProxiedXHR.prototype, 'responseType', {
    get: function () { return this._responseType; },
    set: function (v) {
      this._responseType = v || '';
      if (this._native) { try { this._native.responseType = v; } catch (e) {} }
    },
    configurable: true
  });

  ProxiedXHR.prototype.open = function (method, url, async, user, pass) {
    this._method = method || 'GET';
    this._url    = url;
    if (isHTTP(url)) {
      this._isProxy = true;
      this._native  = null;
      this.readyState = 1;  // OPENED
      this._fire('readystatechange', {});
    } else {
      this._isProxy = false;
      this._native  = new NativeXHR();
      if (this._responseType) {
        try { this._native.responseType = this._responseType; } catch (e) {}
      }
      this._native.open(method, url,
        async === undefined ? true : !!async, user, pass);
    }
  };

  ProxiedXHR.prototype.setRequestHeader = function (name, value) {
    if (this._isProxy) {
      this._reqHeaders[name] = value;
    } else if (this._native) {
      this._native.setRequestHeader(name, value);
    }
  };

  ProxiedXHR.prototype.send = function (body) {
    if (this._isProxy) {
      this._sendViaGM(body);
    } else if (this._native) {
      this._sendViaNative(body);
    }
  };

  ProxiedXHR.prototype._sendViaGM = function (body) {
    var self   = this;
    var gmType = self._responseType === 'arraybuffer' ? 'arraybuffer' :
                 self._responseType === 'blob'        ? 'blob'        : 'text';

    var startEvt = { type: 'loadstart', target: self };
    self._fire('loadstart', startEvt);
    if (self.onloadstart) self.onloadstart(startEvt);

    self._gmReq = GM_xmlhttpRequest({
      method:       self._method,
      url:          self._url,
      headers:      self._reqHeaders,
      data:         body || null,
      responseType: gmType,
      timeout:      self.timeout || undefined,
      anonymous:    !self.withCredentials,

      onload: function (res) {
        self.status           = res.status;
        self.statusText       = res.statusText || '';
        self.responseURL      = res.finalUrl   || self._url;
        self._responseHeaders = parseHeaders(res.responseHeaders || '');

        if (gmType === 'arraybuffer' || gmType === 'blob') {
          self.response     = res.response;
          self.responseText = '';
        } else {
          self.response     = res.responseText || '';
          self.responseText = res.responseText || '';
        }

        self.readyState = 4;
        self._fire('readystatechange', {});

        var loadEvt = { type: 'load', target: self };
        self._fire('load', loadEvt);
        if (self.onload) self.onload(loadEvt);

        var endEvt = { type: 'loadend', target: self };
        self._fire('loadend', endEvt);
        if (self.onloadend) self.onloadend(endEvt);
      },

      onerror: function () {
        self.readyState = 4;
        var evErr = { type: 'error', target: self };
        self._fire('error', evErr);
        if (self.onerror) self.onerror(evErr);
        var evEnd = { type: 'loadend', target: self };
        self._fire('loadend', evEnd);
        if (self.onloadend) self.onloadend(evEnd);
      },

      ontimeout: function () {
        self.readyState = 4;
        var evTm = { type: 'timeout', target: self };
        self._fire('timeout', evTm);
        if (self.ontimeout) self.ontimeout(evTm);
      },

      onprogress: function (res) {
        var evPr = {
          type: 'progress', target: self,
          loaded: res.loaded || 0, total: res.total || 0,
          lengthComputable: !!(res.total)
        };
        self._fire('progress', evPr);
        if (self.onprogress) self.onprogress(evPr);
      }
    });
  };

  ProxiedXHR.prototype._sendViaNative = function (body) {
    var self = this;
    var n    = this._native;

    // Transfer writable properties that may have been set before send()
    try { if (self.timeout)         n.timeout         = self.timeout;         } catch (e) {}
    try { if (self.withCredentials) n.withCredentials = self.withCredentials; } catch (e) {}

    // Forward on* handler properties to the native instance
    ['onreadystatechange', 'onload', 'onerror', 'ontimeout',
     'onprogress', 'onloadstart', 'onloadend', 'onabort'].forEach(function (ev) {
      if (self[ev]) n[ev] = self[ev];
    });

    // Sync readable state back to this proxy whenever the native XHR changes
    n.addEventListener('readystatechange', function () {
      self.readyState = n.readyState;
      if (n.readyState >= 2) {
        self.status     = n.status;
        self.statusText = n.statusText;
      }
      if (n.readyState === 4) {
        try { self.response     = n.response;     } catch (e) {}
        try { self.responseText = n.responseText; } catch (e) {}
        try { self.responseURL  = n.responseURL;  } catch (e) {}
      }
    });

    // Forward any addEventListener-registered listeners to native
    var ls = self._listeners;
    Object.keys(ls).forEach(function (type) {
      ls[type].forEach(function (fn) { n.addEventListener(type, fn); });
    });

    n.send(body);
  };

  ProxiedXHR.prototype.abort = function () {
    if (this._isProxy && this._gmReq) {
      try { this._gmReq.abort(); } catch (e) {}
    } else if (this._native) {
      this._native.abort();
    }
    this.readyState = 0;
    var ev = { type: 'abort', target: this };
    this._fire('abort', ev);
    if (this.onabort) this.onabort(ev);
  };

  ProxiedXHR.prototype.getResponseHeader = function (name) {
    if (this._isProxy) {
      return this._responseHeaders[name.toLowerCase()] || null;
    }
    return this._native ? this._native.getResponseHeader(name) : null;
  };

  ProxiedXHR.prototype.getAllResponseHeaders = function () {
    if (this._isProxy) {
      var lines = Object.keys(this._responseHeaders).map(function (k) {
        return k + ': ' + this._responseHeaders[k];
      }, this);
      // Per XHR spec the return value ends with a trailing CRLF when non-empty.
      return lines.length ? lines.join('\r\n') + '\r\n' : '';
    }
    return this._native ? this._native.getAllResponseHeaders() : '';
  };

  ProxiedXHR.prototype.addEventListener = function (type, fn, options) {
    if (!this._listeners[type]) this._listeners[type] = [];
    if (this._listeners[type].indexOf(fn) === -1) this._listeners[type].push(fn);
    if (this._native) this._native.addEventListener(type, fn, options);
  };

  ProxiedXHR.prototype.removeEventListener = function (type, fn) {
    if (this._listeners[type]) {
      var i = this._listeners[type].indexOf(fn);
      if (i !== -1) this._listeners[type].splice(i, 1);
    }
    if (this._native) this._native.removeEventListener(type, fn);
  };

  ProxiedXHR.prototype._fire = function (type, evt) {
    var fns = this._listeners[type];
    if (!fns || !fns.length) return;
    evt.target = evt.target || this;
    evt.type   = type;
    for (var i = 0; i < fns.length; i++) {
      try { fns[i](evt); } catch (e) {}
    }
  };

  try { w.XMLHttpRequest = ProxiedXHR; } catch (e) {}

  // ── 2. fetch() proxy ──────────────────────────────────────────────────────
  //
  // Some players use fetch() instead of XHR.  The same GM_xmlhttpRequest
  // trick is used; the result is wrapped into a standard Response so that
  // the caller cannot tell the difference.

  var nativeFetch = w.fetch;
  try {
    w.fetch = function (input, init) {
      var url = typeof input === 'string' ? input
              : (input && input.url ? input.url : '');
      if (!isHTTP(url)) return nativeFetch.apply(w, arguments);

      var method     = (init && init.method)  || (input && input.method)  || 'GET';
      var reqHeaders = (init && init.headers) || (input && input.headers) || {};
      var body       = (init && init.body)    || null;

      var headersObj = {};
      if (typeof reqHeaders.forEach === 'function') {
        reqHeaders.forEach(function (v, k) { headersObj[k] = v; });
      } else {
        headersObj = reqHeaders;
      }

      return new Promise(function (resolve, reject) {
        GM_xmlhttpRequest({
          method:       method,
          url:          url,
          headers:      headersObj,
          data:         body,
          responseType: 'arraybuffer',
          onload: function (res) {
            try {
              resolve(new Response(res.response, {
                status:     res.status,
                statusText: res.statusText || '',
                headers:    parseHeaders(res.responseHeaders || '')
              }));
            } catch (e) { reject(e); }
          },
          onerror: function () {
            reject(new TypeError(
              'GM_xmlhttpRequest proxy: network error loading ' + url));
          }
        });
      });
    };
  } catch (e) {}

})();
