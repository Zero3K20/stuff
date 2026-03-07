// ==UserScript==
// @name         QTM Live — Desktop Width Fix
// @namespace    https://th-live.online
// @version      0.3
// @description  Constrains QTM-platform live-streaming sites to a
//               phone-width column when viewed on a wide desktop screen.
//               Overrides the viewport meta at document-start and adds
//               a CSS phone-frame background.  A toggle button lets you
//               switch between phone width and full width on the fly.
// @match        https://th-live.online/*
// @match        https://qqlive.online/*
// @match        https://www.qqlive.online/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

// To add more QTM-clone domains, copy one of the @match lines above and
// change the hostname.  All sites on this platform share the same #app
// structure and will be fixed by the same CSS.

(function () {
  'use strict';

  var PHONE_WIDTH = 390;     // logical CSS px — matches iPhone 14 (common design baseline)
  var VIEWPORT    = 'width=' + PHONE_WIDTH + ',initial-scale=1';

  // Only activate on screens wider than PHONE_WIDTH.
  // Use window.innerWidth (CSS pixels) so the check is DPI-independent.
  // At document-start innerWidth may be 0; fall back to screen.width.
  var viewportWidth = window.innerWidth || window.screen.width;
  if (viewportWidth <= PHONE_WIDTH) return;

  // ── 1. Viewport meta override ──────────────────────────────────────────────
  //
  // Bug in v0.2: the script runs at document-start before the HTML is parsed,
  // so any <meta> we create is inserted *before* the site's own viewport meta.
  // Browsers (Chrome, Firefox) use the *last* <meta name="viewport"> when
  // duplicates exist, so the site's later-parsed meta silently wins.
  //
  // Fix: use querySelectorAll so we find and update *every* viewport meta that
  // exists at call time — including the site's own tag after it is parsed —
  // and attach a MutationObserver to each one so JS attribute-reassignments
  // are immediately reversed.  vpChildObserver watches for new metas being
  // added (covers both the static HTML parse and any createElement calls).

  var vpAttrObservers = [];   // one entry per watched <meta name="viewport">
  var vpLocked = false;       // re-entrancy guard

  function disconnectVpAttrObservers() {
    for (var i = 0; i < vpAttrObservers.length; i++) vpAttrObservers[i].disconnect();
    vpAttrObservers = [];
  }

  function applyViewport() {
    if (vpLocked) return;
    vpLocked = true;

    var all = document.querySelectorAll('meta[name="viewport"]');

    if (all.length === 0) {
      // No viewport meta in the DOM yet — create one.  vpChildObserver will
      // fire when it is inserted and call applyViewport again.
      var m = document.createElement('meta');
      m.name    = 'viewport';
      m.content = VIEWPORT;
      (document.head || document.documentElement).appendChild(m);
      vpLocked = false;
      return;
    }

    // Override every existing viewport meta (the browser uses the last one,
    // so we must update all of them, not just the first).
    for (var i = 0; i < all.length; i++) {
      if (all[i].content !== VIEWPORT) all[i].content = VIEWPORT;
    }

    // Reconnect attribute observers so any JS content-assignment is reversed.
    disconnectVpAttrObservers();
    for (var j = 0; j < all.length; j++) {
      (function watchMeta(el) {
        var obs = new MutationObserver(function () {
          if (el.content !== VIEWPORT) el.content = VIEWPORT;
        });
        obs.observe(el, { attributes: true, attributeFilter: ['content'] });
        vpAttrObservers.push(obs);
      }(all[j]));
    }

    vpLocked = false;
  }

  applyViewport();

  // Watch for new <meta name="viewport"> elements being added to the document.
  var vpChildObserver = new MutationObserver(function (mutations) {
    for (var mi = 0; mi < mutations.length; mi++) {
      var added = mutations[mi].addedNodes;
      for (var ni = 0; ni < added.length; ni++) {
        var n = added[ni];
        if (n.nodeType !== 1) continue;
        var isVp = n.tagName === 'META' &&
                   (n.name === 'viewport' || n.getAttribute('name') === 'viewport');
        var containsVp = !isVp && n.querySelector && n.querySelector('meta[name="viewport"]');
        if (isVp || containsVp) { applyViewport(); return; }
      }
    }
  });
  vpChildObserver.observe(document.documentElement, { childList: true, subtree: true });

  document.addEventListener('DOMContentLoaded', function () {
    vpChildObserver.disconnect();   // static DOM is complete; attribute observers take over
    applyViewport();

    // Poll for ~5 s to catch any late SPA viewport reset (e.g. Vue mounted hook)
    var ticks = 0;
    var MAX_POLL_TICKS = 10;   // 10 ticks × 500 ms = 5 s
    var poll = setInterval(function () {
      applyViewport();
      if (++ticks >= MAX_POLL_TICKS) clearInterval(poll);
    }, 500);
  });

  // ── 2. CSS ─────────────────────────────────────────────────────────────────
  //
  // Three complementary layers:
  //
  //   Layer A — root font-size pin
  //     QTM Live sites use the "flexible" rem layout: the page's own JS sets
  //     html { font-size: clientWidth / 10 }.  On a real 390 px phone that
  //     gives 39 px.  When the viewport meta override is applied late (or the
  //     browser hasn't propagated the change yet), the site's script may read
  //     the full desktop clientWidth and set a much larger font-size, making
  //     every rem-sized element too big to fit the 390 px column.
  //     Pinning the root font-size with !important fixes this regardless of
  //     when the viewport override takes effect.
  //
  //   Layer B — container centering
  //     Centers #app on a dark desktop background and caps its width at
  //     PHONE_WIDTH px.
  //
  //   Layer C — fixed-element repositioning
  //     Vant UI components such as van-tabbar (bottom nav), van-nav-bar (top
  //     nav) and popups use  position:fixed; left:0; right:0  so they span the
  //     full *viewport* width, not the #app container width.  Without this
  //     layer those bars remain full-screen-wide.
  //
  //     The formula:  left: max(0px, calc(50vw - 195px))
  //                   width: min(390px, 100vw)
  //                   right: auto
  //     centres them over the phone column whether the viewport is 390 px
  //     (meta override working) or the full desktop width (fallback mode).

  var PHONE_HALF_WIDTH    = (PHONE_WIDTH / 2) + 'px';        // '195px'
  var COL_LEFT            = 'max(0px,calc(50vw - ' + PHONE_HALF_WIDTH + '))';
  var COL_WIDTH           = 'min(' + PHONE_WIDTH + 'px,100vw)';
  var PHONE_ROOT_FONT_SIZE = (PHONE_WIDTH / 10) + 'px';      // '39px' (flexible.js at 390 px)

  // Selectors for every Vant UI element that uses position:fixed / sticky
  // and spans the full viewport width.
  var FIXED_SELECTORS = [
    '.van-tabbar',
    '.van-nav-bar',
    '.van-sticky > .van-nav-bar',
    '.van-sticky > [class]',
    '.van-notify',
    '.van-overlay',
    '.van-popup--bottom',
    '.van-popup--top',
    '.van-popup--left',
    '.van-popup--right',
    '.van-action-sheet',
    '.van-share-sheet',
    '.van-number-keyboard'
  ].join(',\n  ');

  var CSS = [
    '/* ── root font-size + background ── */',
    'html {',
    '  font-size: ' + PHONE_ROOT_FONT_SIZE + ' !important;',
    '  background: #111 !important;',
    '}',
    'body {',
    '  display: flex !important;',
    '  justify-content: center !important;',
    '  min-height: 100vh !important;',
    '  background: #111 !important;',
    '  margin: 0 !important;',
    '  padding: 0 !important;',
    '}',
    '#app, [data-v-app] {',
    '  max-width: ' + PHONE_WIDTH + 'px !important;',
    '  width: 100% !important;',
    '  box-shadow: 0 0 60px rgba(0,0,0,.7) !important;',
    '  min-height: 100vh !important;',
    '  overflow-x: hidden !important;',
    '  position: relative !important;',
    '}',
    '',
    '/* ── fixed / overlay elements ── */',
    '  ' + FIXED_SELECTORS + ' {',
    '  left:  ' + COL_LEFT  + ' !important;',
    '  width: ' + COL_WIDTH + ' !important;',
    '  right: auto !important;',
    '  max-width: ' + PHONE_WIDTH + 'px !important;',
    '}',
    '',
    '/* van-toast is centred by transform; keep its anchor in the column */',
    '.van-toast {',
    '  left: 50vw !important;',
    '}'
  ].join('\n');

  var styleEl = document.createElement('style');
  styleEl.id          = '__qtm_width_fix';
  styleEl.textContent = CSS;
  (document.head || document.documentElement).appendChild(styleEl);

  // ── 3. Toggle button ───────────────────────────────────────────────────────
  //
  // A small button fixed to the top-right corner.  Clicking it switches
  // between phone-width mode and full-width mode.

  var phoneMode = true;

  function applyMode() {
    styleEl.disabled = !phoneMode;
    if (phoneMode) {
      applyViewport();
    } else {
      disconnectVpAttrObservers();
      var vp = document.querySelector('meta[name="viewport"]');
      if (vp) vp.content = 'width=device-width,initial-scale=1';
    }
    if (btn) {
      btn.textContent = phoneMode ? '\u229e Full width' : '\u260e Phone width';
      btn.title = phoneMode
        ? 'Click to restore full-width layout'
        : 'Click to re-enable phone-width fix';
    }
  }

  var btn = null;

  window.addEventListener('load', function () {
    btn = document.createElement('button');
    btn.textContent = '\u229e Full width';
    btn.title = 'Click to restore full-width layout';
    btn.style.cssText = [
      'position:fixed',
      'top:8px',
      'right:8px',
      'z-index:2147483647',
      'background:rgba(0,0,0,.55)',
      'color:#fff',
      'border:1px solid rgba(255,255,255,.25)',
      'border-radius:6px',
      'padding:4px 9px',
      'font-size:11px',
      'line-height:1.5',
      'cursor:pointer',
      'font-family:sans-serif',
      'user-select:none',
      '-webkit-user-select:none'
    ].join(';');
    btn.onclick = function () {
      phoneMode = !phoneMode;
      applyMode();
    };
    document.body.appendChild(btn);
  });
})();
