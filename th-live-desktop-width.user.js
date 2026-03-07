// ==UserScript==
// @name         QTM Live — Desktop Width Fix
// @namespace    https://th-live.online
// @version      0.4
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

  // Read the REAL viewport width before we override window.innerWidth.
  // screen.width is the physical screen CSS-pixel width and is never overridden.
  var realViewportWidth = window.screen.width;
  if (realViewportWidth <= PHONE_WIDTH) return;

  // phoneMode must be declared here (before the property getters below reference it
  // via closure) even though it is assigned before any getter is ever called.
  var phoneMode = true;

  // ── 1. Override window.innerWidth / document.documentElement.clientWidth ───
  //
  // These must be intercepted at document-start — before flexible.js or any
  // Vant component initialises — so that every JS layout calculation that reads
  // these values uses PHONE_WIDTH instead of the actual desktop viewport width.
  //
  // Without this, flexible.js reads clientWidth = 1440 and sets
  //   html { font-size: 144px }
  // and Vant Sticky reads innerWidth = 1440 when it positions fixed elements,
  // making them span the full desktop screen.
  //
  // When the user toggles to full-width mode we delete the overrides so the
  // native browser values are restored automatically.

  try {
    Object.defineProperty(window, 'innerWidth', {
      get: function () { return phoneMode ? PHONE_WIDTH : realViewportWidth; },
      configurable: true
    });
  } catch (e) {}

  try {
    // document.documentElement.clientWidth is what most flexible.js variants read.
    // Overriding it on the *instance* (not Element.prototype) keeps the override
    // isolated to just this element.
    var _elCWDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth');
    Object.defineProperty(document.documentElement, 'clientWidth', {
      get: function () {
        if (phoneMode) return PHONE_WIDTH;
        return _elCWDesc ? _elCWDesc.get.call(this) : realViewportWidth;
      },
      configurable: true
    });
  } catch (e) {}

  // ── 2. Viewport meta override ──────────────────────────────────────────────
  //
  // Two independent observers keep the viewport meta locked to PHONE_WIDTH:
  //
  //   vpChildObserver  — watches the whole document for a new <meta> element
  //                      being inserted (catches the static HTML meta and any
  //                      createElement + appendChild calls).
  //   vpAttrObservers  — one per viewport meta; watches the content attribute
  //                      so that a plain JS assignment like
  //                        meta.content = '...'
  //                      is immediately reversed.
  //
  // querySelectorAll is used (not querySelector) so ALL duplicate viewport metas
  // are corrected — browsers use the *last* one, so any site-inserted tag that
  // comes after ours must also be locked.

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

    // Lock every existing viewport meta.
    for (var i = 0; i < all.length; i++) {
      if (all[i].content !== VIEWPORT) all[i].content = VIEWPORT;
    }

    // Reconnect attribute observers.
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

  // Watch for new <meta name="viewport"> elements being added.
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

    // Poll for ~5 s to catch any late SPA viewport reset (e.g. Vue mounted hook).
    var ticks = 0;
    var MAX_POLL_TICKS = 10;   // 10 ticks × 500 ms = 5 s
    var poll = setInterval(function () {
      applyViewport();
      if (++ticks >= MAX_POLL_TICKS) clearInterval(poll);
    }, 500);
  });

  // ── 3. CSS ─────────────────────────────────────────────────────────────────
  //
  // Layer A — root font-size pin
  //   Ensures the rem baseline is correct even if flexible.js already ran
  //   before our window.innerWidth override was applied.
  //
  // Layer B — container centering
  //   Centers #app in a dark desktop surround, capped at PHONE_WIDTH px.
  //
  // Layer C — named fixed-element repositioning (Vant UI class names)
  //   CSS !important overrides inline styles set by Vant's own JS.
  //   Centres fixed elements over the phone column:
  //     left:  max(0px, calc(50vw - 195px))
  //     width: min(390px, 100vw)
  //   Works whether the viewport is 390 px (meta override succeeded) or the
  //   full desktop width (meta override failed — CSS-only fallback).

  var PHONE_HALF_WIDTH     = (PHONE_WIDTH / 2) + 'px';        // '195px'
  var COL_LEFT             = 'max(0px,calc(50vw - ' + PHONE_HALF_WIDTH + '))';
  var COL_WIDTH            = 'min(' + PHONE_WIDTH + 'px,100vw)';
  var PHONE_ROOT_FONT_SIZE = (PHONE_WIDTH / 10) + 'px';        // '39px'

  // Vant UI selectors for elements that use position:fixed and span the viewport.
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
    '/* ── Vant fixed / overlay elements ── */',
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

  // ── 4. JS fixed-element scan ───────────────────────────────────────────────
  //
  // The CSS layer above covers known Vant class names, but QTM Live sites also
  // have custom components (e.g. the home-page section tab bar) with site-
  // specific class names not in the Vant selector list.
  //
  // This scan iterates every element in the live DOM, finds those whose
  // *computed* position is "fixed", and inlines the same left/width constraints
  // with !important priority.  It runs:
  //   • once immediately after DOMContentLoaded (catches initial Vant setup)
  //   • every 500 ms for 6 seconds after window load (catches elements that
  //     become fixed during Vue's mounted() lifecycle or after lazy hydration)
  //
  // Elements are tagged with data-qtm-fixed="1" so they are only processed
  // once per scan cycle.

  function fixAllFixedEls() {
    if (!phoneMode || !document.body) return;
    var els = document.body.querySelectorAll('*');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.id === '__qtm_btn') continue;
      if (window.getComputedStyle(el).position !== 'fixed') continue;
      el.style.setProperty('max-width', PHONE_WIDTH + 'px', 'important');
      el.style.setProperty('width',     COL_WIDTH,           'important');
      el.style.setProperty('left',      COL_LEFT,            'important');
      el.style.setProperty('right',     'auto',              'important');
    }
  }

  document.addEventListener('DOMContentLoaded', fixAllFixedEls);

  window.addEventListener('load', function () {
    fixAllFixedEls();
    var scanTicks = 0;
    var scanMax   = 12;   // 12 × 500 ms = 6 s
    var scanPoll  = setInterval(function () {
      fixAllFixedEls();
      if (++scanTicks >= scanMax) clearInterval(scanPoll);
    }, 500);
  });

  // ── 5. Toggle button ───────────────────────────────────────────────────────
  //
  // A small button fixed to the top-right corner.  Clicking it switches
  // between phone-width mode and full-width mode.

  function applyMode() {
    styleEl.disabled = !phoneMode;

    if (phoneMode) {
      // Re-establish the innerWidth / clientWidth overrides in case the toggle
      // was clicked while they had been deleted.
      try {
        Object.defineProperty(window, 'innerWidth', {
          get: function () { return PHONE_WIDTH; },
          configurable: true
        });
      } catch (e) {}
      try {
        Object.defineProperty(document.documentElement, 'clientWidth', {
          get: function () { return PHONE_WIDTH; },
          configurable: true
        });
      } catch (e) {}
      applyViewport();
      fixAllFixedEls();
    } else {
      // Full-width mode: remove our property overrides so native values return.
      try { delete window.innerWidth; }                       catch (e) {}
      try { delete document.documentElement.clientWidth; }   catch (e) {}
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
    btn.id          = '__qtm_btn';
    btn.textContent = '\u229e Full width';
    btn.title       = 'Click to restore full-width layout';
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
