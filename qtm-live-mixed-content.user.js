// ==UserScript==
// @name         QTM Live — Force HTTPS Streams
// @namespace    https://th-live.online
// @version      0.1
// @description  Upgrades every http:// URL to https:// at the network layer
//               so that live streams (HLS manifests, .ts segments, WebSocket
//               signalling) are never blocked by the browser's mixed-content
//               policy when the page itself is served over HTTPS.
//               Intercepts XMLHttpRequest, fetch, and <video>/<source> src
//               assignments before any player library initialises.
// @match        https://th-live.online/*
// @match        https://qqlive.online/*
// @match        https://www.qqlive.online/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

// To add more QTM-clone domains, copy one of the @match lines above and
// change the hostname.  All sites on this platform share the same player
// stack (hls.js / video.js) and will be fixed by the same interceptions.

(function () {
  'use strict';

  // ── upgradeURL ─────────────────────────────────────────────────────────────
  //
  // Replace the http:// scheme with https://.  All other URLs (https://, //,
  // data:, blob:, ws://, etc.) are returned unchanged.
  //
  // ws:// (plain WebSocket) is also upgraded to wss:// so that signalling
  // channels (used by some QTM Live rooms for chat and gift events) are not
  // blocked either.

  function upgradeURL(url) {
    if (typeof url !== 'string') return url;
    if (url.startsWith('http://'))  return 'https://' + url.slice(7);
    if (url.startsWith('ws://'))    return 'wss://'   + url.slice(5);
    return url;
  }

  // ── 1. XMLHttpRequest ──────────────────────────────────────────────────────
  //
  // HLS players (hls.js, video.js HLS plugin, DPlayer) load .m3u8 manifests
  // and .ts segment files via XMLHttpRequest.  Any http:// URL passed to
  // xhr.open() would normally be blocked as active mixed content; upgrading
  // it here makes the request succeed without any browser security warning.

  try {
    var _xhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, async, user, pass) {
      return _xhrOpen.call(this, method, upgradeURL(url), async, user, pass);
    };
  } catch (e) {}

  // ── 2. fetch ───────────────────────────────────────────────────────────────
  //
  // Modern players and the site's own API calls use fetch().  The first
  // argument may be a plain string URL or a Request object.

  try {
    var _fetch = window.fetch;
    window.fetch = function (input, init) {
      if (typeof input === 'string') {
        input = upgradeURL(input);
      } else if (input && typeof input === 'object' && 'url' in input) {
        // Request object — reconstruct only if the URL needs upgrading so we
        // do not disturb any attached body stream on requests that are already
        // HTTPS.
        var upgraded = upgradeURL(input.url);
        if (upgraded !== input.url) {
          input = new Request(upgraded, input);
        }
      }
      return _fetch.call(this, input, init);
    };
  } catch (e) {}

  // ── 3. WebSocket ───────────────────────────────────────────────────────────
  //
  // Some QTM Live rooms open a plain ws:// WebSocket for real-time events
  // (chat, gift animations, viewer count).  Browsers block ws:// connections
  // from HTTPS pages as mixed content.  Wrapping the WebSocket constructor
  // upgrades the URL to wss:// before the connection is attempted.

  try {
    var _WebSocket = window.WebSocket;
    window.WebSocket = function (url, protocols) {
      return protocols !== undefined
        ? new _WebSocket(upgradeURL(url), protocols)
        : new _WebSocket(upgradeURL(url));
    };
    // Copy static properties (WebSocket.CONNECTING, .OPEN, etc.) and prototype.
    window.WebSocket.prototype     = _WebSocket.prototype;
    window.WebSocket.CONNECTING    = _WebSocket.CONNECTING;
    window.WebSocket.OPEN          = _WebSocket.OPEN;
    window.WebSocket.CLOSING       = _WebSocket.CLOSING;
    window.WebSocket.CLOSED        = _WebSocket.CLOSED;
  } catch (e) {}

  // ── 4. <video> / <audio> / <source> src property setter ───────────────────
  //
  // When a player sets `videoElement.src = 'http://...'` or appends a
  // `<source src="http://...">` element the browser tries to load that URL
  // immediately.  Patching the IDL attribute setters on HTMLMediaElement and
  // HTMLSourceElement upgrades the URL before the browser ever sees it.

  function patchSrcSetter(proto) {
    try {
      var desc = Object.getOwnPropertyDescriptor(proto, 'src');
      if (!desc || !desc.set) return;
      var origSet = desc.set;
      Object.defineProperty(proto, 'src', {
        get: desc.get,
        set: function (val) { origSet.call(this, upgradeURL(val)); },
        configurable: true,
        enumerable:   desc.enumerable
      });
    } catch (e) {}
  }

  patchSrcSetter(HTMLMediaElement.prototype);   // <video>, <audio>
  patchSrcSetter(HTMLSourceElement.prototype);  // <source>

  // ── 5. MutationObserver fallback ───────────────────────────────────────────
  //
  // Some QTM Live pages set the stream URL via a direct `src` HTML attribute
  // (e.g. through v-bind:src / innerHTML).  The property-setter patch above
  // does not fire for attribute mutations, so we also watch the DOM for
  // <video>/<audio>/<source> nodes with an http:// src attribute and upgrade
  // them in place.

  function upgradeElSrc(el) {
    var tag = el.tagName;
    if (tag !== 'VIDEO' && tag !== 'AUDIO' && tag !== 'SOURCE') return;
    // Read the raw attribute, not the reflected property, to avoid triggering
    // an infinite loop through the setter we patched above.
    var attr = el.getAttribute('src');
    if (attr && (attr.startsWith('http://') || attr.startsWith('ws://'))) {
      el.setAttribute('src', upgradeURL(attr));
    }
  }

  function upgradeSubtree(root) {
    upgradeElSrc(root);
    if (typeof root.querySelectorAll === 'function') {
      var els = root.querySelectorAll('video[src], audio[src], source[src]');
      for (var i = 0; i < els.length; i++) {
        upgradeElSrc(els[i]);
      }
    }
  }

  var _observer = new MutationObserver(function (mutations) {
    for (var mi = 0; mi < mutations.length; mi++) {
      var mut = mutations[mi];
      if (mut.type === 'childList') {
        var added = mut.addedNodes;
        for (var ni = 0; ni < added.length; ni++) {
          if (added[ni].nodeType === 1) upgradeSubtree(added[ni]);
        }
      } else if (mut.type === 'attributes') {
        // An existing element had its src attribute changed.
        upgradeElSrc(mut.target);
      }
    }
  });

  // Start observing as soon as body is available; also sweep any elements
  // already present in the DOM once DOMContentLoaded fires.
  function startObserver() {
    if (!document.body) return;
    _observer.observe(document.body, {
      childList:     true,
      subtree:       true,
      attributes:    true,
      attributeFilter: ['src']
    });
    upgradeSubtree(document.body);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserver);
  } else {
    startObserver();
  }

})();
